#!/usr/bin/env node
/**
 * Version consistency linter for alma-plugins.
 *
 * Alma decides whether a plugin has an update by comparing the *installed*
 * manifest.json version against the version advertised in registry.json
 * (see electron/plugins/pluginManager.ts -> checkForUpdates).
 *
 * If registry.json says 0.7.5 but plugins/<id>/manifest.json still says 0.7.4,
 * every user gets an update prompt, installs the very same package, still reads
 * 0.7.4 from the manifest, and gets prompted again — forever.
 *
 * This linter makes that class of mistake impossible to merge.
 *
 * Usage:
 *   node scripts/lint-versions.mjs           # lint
 *   node scripts/lint-versions.mjs --fix     # sync registry.json <- manifest.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGINS_DIR = join(ROOT, "plugins");
const REGISTRY_PATH = join(ROOT, "registry.json");
const FIX = process.argv.includes("--fix");
const IS_CI = process.env.GITHUB_ACTIONS === "true";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const problems = [];
const notes = [];

/** Report a problem, optionally anchored to a file/line for a GitHub annotation. */
function fail(message, { file, line, hint } = {}) {
	problems.push({ message, file, line, hint });
}

function rel(p) {
	return relative(ROOT, p).split("\\").join("/");
}

function readJson(path) {
	const raw = readFileSync(path, "utf8");
	try {
		return { data: JSON.parse(raw), raw };
	} catch (err) {
		throw new Error(`${rel(path)} is not valid JSON: ${err.message}`);
	}
}

/** 1-based line number of a top-level `"key"` in a raw JSON string (best effort). */
function lineOfKey(raw, key) {
	const lines = raw.split("\n");
	const needle = `"${key}"`;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(needle)) return i + 1;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Load registry
// ---------------------------------------------------------------------------

if (!existsSync(REGISTRY_PATH)) {
	console.error("registry.json not found at repo root");
	process.exit(1);
}

const { data: registry, raw: registryRaw } = readJson(REGISTRY_PATH);

if (!Array.isArray(registry.plugins)) {
	console.error("registry.json: `plugins` must be an array");
	process.exit(1);
}

const registryById = new Map();
for (const entry of registry.plugins) {
	if (!entry?.id) {
		fail("registry.json contains an entry without an `id`", { file: "registry.json" });
		continue;
	}
	if (registryById.has(entry.id)) {
		fail(`registry.json lists duplicate id \`${entry.id}\``, {
			file: "registry.json",
			line: lineOfKey(registryRaw, entry.id),
		});
	}
	registryById.set(entry.id, entry);
}

// ---------------------------------------------------------------------------
// Walk plugin directories
// ---------------------------------------------------------------------------

const pluginDirs = existsSync(PLUGINS_DIR)
	? readdirSync(PLUGINS_DIR)
			.filter((name) => !name.startsWith(".") && statSync(join(PLUGINS_DIR, name)).isDirectory())
			.sort()
	: [];

const seenIds = new Set();

for (const dir of pluginDirs) {
	const pluginDir = join(PLUGINS_DIR, dir);
	const manifestPath = join(pluginDir, "manifest.json");
	const manifestRel = rel(manifestPath);

	if (!existsSync(manifestPath)) {
		fail(`plugins/${dir}/ has no manifest.json`, { file: `plugins/${dir}` });
		continue;
	}

	let manifest;
	let manifestRaw;
	try {
		({ data: manifest, raw: manifestRaw } = readJson(manifestPath));
	} catch (err) {
		fail(err.message, { file: manifestRel });
		continue;
	}

	const manifestVersionLine = lineOfKey(manifestRaw, "version");

	// --- id must match the directory name (registry lookups rely on it) ------
	if (manifest.id !== dir) {
		fail(`manifest id \`${manifest.id}\` does not match its directory name \`${dir}\``, {
			file: manifestRel,
			line: lineOfKey(manifestRaw, "id"),
			hint: "Alma keys installed plugins by manifest id; it must equal the folder name.",
		});
	}
	seenIds.add(manifest.id ?? dir);

	// --- version must be valid semver ---------------------------------------
	if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
		fail(`manifest version \`${manifest.version}\` is not valid semver (x.y.z)`, {
			file: manifestRel,
			line: manifestVersionLine,
		});
		continue;
	}

	// --- entry point must exist (built .js, or its .ts source) --------------
	const main = manifest.main ?? "main.js";
	const entryCandidates = [main, main.replace(/\.js$/, ".ts")];
	if (!entryCandidates.some((candidate) => existsSync(join(pluginDir, candidate)))) {
		fail(
			`manifest points at \`${main}\` but neither ${entryCandidates
				.map((c) => `plugins/${dir}/${c}`)
				.join(" nor ")} exists`,
			{
				file: manifestRel,
				line: lineOfKey(manifestRaw, "main"),
			},
		);
	}

	// --- package.json must agree, when present ------------------------------
	const pkgPath = join(pluginDir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const { data: pkg, raw: pkgRaw } = readJson(pkgPath);
			if (pkg.version !== manifest.version) {
				fail(
					`package.json version \`${pkg.version}\` != manifest.json version \`${manifest.version}\``,
					{
						file: rel(pkgPath),
						line: lineOfKey(pkgRaw, "version"),
						hint: `Bump both to the same value (probably \`${manifest.version}\`).`,
					},
				);
			}
		} catch (err) {
			fail(err.message, { file: rel(pkgPath) });
		}
	}

	// --- registry entry must exist and agree --------------------------------
	const entry = registryById.get(manifest.id ?? dir);
	if (!entry) {
		fail(`plugins/${dir}/ is not listed in registry.json`, {
			file: "registry.json",
			hint: "Add an entry so the marketplace can see this plugin.",
		});
		continue;
	}

	const expectedPath = `plugins/${dir}`;
	if (entry.path !== expectedPath) {
		fail(`registry path \`${entry.path}\` for \`${entry.id}\` should be \`${expectedPath}\``, {
			file: "registry.json",
			line: lineOfKey(registryRaw, entry.id),
		});
	}

	if (entry.version !== manifest.version) {
		if (FIX) {
			entry.version = manifest.version;
			notes.push(`fixed registry.json: ${entry.id} -> ${manifest.version}`);
		} else {
			fail(
				`registry.json advertises \`${entry.id}@${entry.version}\` but ` +
					`${manifestRel} says \`${manifest.version}\``,
				{
					file: "registry.json",
					line: lineOfKey(registryRaw, entry.id),
					hint:
						"Users would install the manifest version, compare it against the registry " +
						"version, and be told to update forever. Run `node scripts/lint-versions.mjs --fix`.",
				},
			);
		}
	}

	// --- CHANGELOG should document the released version ---------------------
	const changelogPath = join(pluginDir, "CHANGELOG.md");
	if (existsSync(changelogPath)) {
		const changelog = readFileSync(changelogPath, "utf8");
		const documented = new RegExp(
			`^#{1,3}\\s*\\[?v?${manifest.version.replace(/\./g, "\\.")}\\]?`,
			"m",
		).test(changelog);
		if (!documented) {
			fail(`CHANGELOG.md has no section for version ${manifest.version}`, {
				file: rel(changelogPath),
				line: 1,
				hint: "A stale changelog usually means the version bump was only half-applied.",
			});
		}
	}
}

// --- registry entries pointing at nothing ----------------------------------
for (const [id, entry] of registryById) {
	if (seenIds.has(id)) continue;
	fail(`registry.json lists \`${id}\` but plugins/${id}/ does not exist`, {
		file: "registry.json",
		line: lineOfKey(registryRaw, id),
	});
	void entry;
}

// ---------------------------------------------------------------------------
// Apply --fix / report
// ---------------------------------------------------------------------------

if (FIX && notes.length > 0) {
	registry.lastUpdated = new Date().toISOString().slice(0, 10);
	writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
	for (const note of notes) console.log(`  ${note}`);
}

const checked = `${pluginDirs.length} plugin${pluginDirs.length === 1 ? "" : "s"}`;

if (problems.length === 0) {
	console.log(`version lint: ${checked} checked, everything is consistent`);
	process.exit(0);
}

console.error(`version lint: ${problems.length} problem(s) across ${checked}\n`);
for (const { message, file, line, hint } of problems) {
	const where = file ? `${file}${line ? `:${line}` : ""}` : "repo";
	console.error(`  ✗ ${where}\n    ${message}`);
	if (hint) console.error(`    → ${hint}`);
	if (IS_CI) {
		const loc = [file && `file=${file}`, line && `line=${line}`].filter(Boolean).join(",");
		const body = `${message}${hint ? ` — ${hint}` : ""}`.replace(/\r?\n/g, "%0A");
		console.log(`::error ${loc},title=Plugin version mismatch::${body}`);
	}
}
console.error("");
process.exit(1);
