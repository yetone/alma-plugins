import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// lib/auth.ts
var CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
var CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
var CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
var POLL_MAX_ATTEMPTS = 150;
var POLL_BASE_DELAY = 1000;
var POLL_MAX_DELAY = 1e4;
var POLL_BACKOFF_MULTIPLIER = 1.2;
async function generatePKCE() {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");
  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = Buffer.from(hashBuffer).toString("base64url");
  return { verifier, challenge };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function generateCursorAuthParams() {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli"
  });
  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
  return { verifier, challenge, uuid, loginUrl };
}
async function pollCursorAuth(uuid, verifier) {
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;
  let lastError;
  for (let attempt = 0;attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay);
    try {
      const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
        continue;
      }
      if (response.ok) {
        const data = await response.json();
        return {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken
        };
      }
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Poll failed: ${response.status}${errorBody ? ` - ${errorBody}` : ""}`);
    } catch (err) {
      consecutiveErrors++;
      lastError = err instanceof Error ? err.message : String(err);
      if (consecutiveErrors >= 10) {
        throw new Error(`Too many consecutive errors during Cursor auth polling (last: ${lastError})`);
      }
      delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
    }
  }
  throw new Error("Cursor authentication polling timeout");
}
async function refreshCursorToken(refreshToken) {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cursor token refresh failed: ${error}`);
  }
  const data = await response.json();
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken || refreshToken,
    expires_at: getTokenExpiry(data.accessToken)
  };
}
function getTokenExpiry(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600 * 1000;
    }
    const decoded = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {}
  return Date.now() + 3600 * 1000;
}

// lib/token-store.ts
var STORAGE_KEY = "cursor_tokens";

class TokenStore {
  secrets;
  logger;
  cachedTokens = null;
  refreshPromise = null;
  constructor(secrets, logger) {
    this.secrets = secrets;
    this.logger = logger;
  }
  async initialize() {
    try {
      const stored = await this.secrets.get(STORAGE_KEY);
      if (stored) {
        this.cachedTokens = JSON.parse(stored);
        this.logger.info("Loaded cached Cursor tokens");
      }
    } catch (error) {
      this.logger.warn("Failed to load cached tokens:", error);
      this.cachedTokens = null;
    }
  }
  hasValidToken() {
    if (!this.cachedTokens) {
      return false;
    }
    return !!this.cachedTokens.refresh_token;
  }
  getTokens() {
    return this.cachedTokens;
  }
  async saveTokens(tokens) {
    this.cachedTokens = tokens;
    await this.secrets.set(STORAGE_KEY, JSON.stringify(tokens));
    this.logger.info("Saved Cursor tokens");
  }
  async clearTokens() {
    this.cachedTokens = null;
    await this.secrets.delete(STORAGE_KEY);
    this.logger.info("Cleared Cursor tokens");
  }
  async getValidAccessToken() {
    if (!this.cachedTokens) {
      throw new Error("Not authenticated. Please login first.");
    }
    if (Date.now() < this.cachedTokens.expires_at) {
      return this.cachedTokens.access_token;
    }
    this.logger.info("Access token expired, refreshing...");
    if (this.refreshPromise) {
      const tokens = await this.refreshPromise;
      return tokens.access_token;
    }
    this.refreshPromise = this.doRefresh();
    try {
      const tokens = await this.refreshPromise;
      return tokens.access_token;
    } finally {
      this.refreshPromise = null;
    }
  }
  async doRefresh() {
    if (!this.cachedTokens?.refresh_token) {
      throw new Error("No refresh token available. Please login again.");
    }
    try {
      const newTokens = await refreshCursorToken(this.cachedTokens.refresh_token);
      await this.saveTokens(newTokens);
      this.logger.info("Successfully refreshed Cursor tokens");
      return newTokens;
    } catch (error) {
      this.logger.error("Failed to refresh tokens:", error);
      await this.clearTokens();
      throw new Error("Token refresh failed. Please login again.");
    }
  }
}

// lib/models.ts
import * as http2 from "node:http2";
// node_modules/@bufbuild/protobuf/dist/esm/is-message.js
function isMessage(arg, schema) {
  const isMessage2 = arg !== null && typeof arg == "object" && "$typeName" in arg && typeof arg.$typeName == "string";
  if (!isMessage2) {
    return false;
  }
  if (schema === undefined) {
    return true;
  }
  return schema.typeName === arg.$typeName;
}
// node_modules/@bufbuild/protobuf/dist/esm/descriptors.js
var ScalarType;
(function(ScalarType2) {
  ScalarType2[ScalarType2["DOUBLE"] = 1] = "DOUBLE";
  ScalarType2[ScalarType2["FLOAT"] = 2] = "FLOAT";
  ScalarType2[ScalarType2["INT64"] = 3] = "INT64";
  ScalarType2[ScalarType2["UINT64"] = 4] = "UINT64";
  ScalarType2[ScalarType2["INT32"] = 5] = "INT32";
  ScalarType2[ScalarType2["FIXED64"] = 6] = "FIXED64";
  ScalarType2[ScalarType2["FIXED32"] = 7] = "FIXED32";
  ScalarType2[ScalarType2["BOOL"] = 8] = "BOOL";
  ScalarType2[ScalarType2["STRING"] = 9] = "STRING";
  ScalarType2[ScalarType2["BYTES"] = 12] = "BYTES";
  ScalarType2[ScalarType2["UINT32"] = 13] = "UINT32";
  ScalarType2[ScalarType2["SFIXED32"] = 15] = "SFIXED32";
  ScalarType2[ScalarType2["SFIXED64"] = 16] = "SFIXED64";
  ScalarType2[ScalarType2["SINT32"] = 17] = "SINT32";
  ScalarType2[ScalarType2["SINT64"] = 18] = "SINT64";
})(ScalarType || (ScalarType = {}));

// node_modules/@bufbuild/protobuf/dist/esm/wire/varint.js
function varint64read() {
  let lowBits = 0;
  let highBits = 0;
  for (let shift = 0;shift < 28; shift += 7) {
    let b = this.buf[this.pos++];
    lowBits |= (b & 127) << shift;
    if ((b & 128) == 0) {
      this.assertBounds();
      return [lowBits, highBits];
    }
  }
  let middleByte = this.buf[this.pos++];
  lowBits |= (middleByte & 15) << 28;
  highBits = (middleByte & 112) >> 4;
  if ((middleByte & 128) == 0) {
    this.assertBounds();
    return [lowBits, highBits];
  }
  for (let shift = 3;shift <= 31; shift += 7) {
    let b = this.buf[this.pos++];
    highBits |= (b & 127) << shift;
    if ((b & 128) == 0) {
      this.assertBounds();
      return [lowBits, highBits];
    }
  }
  throw new Error("invalid varint");
}
function varint64write(lo, hi, bytes) {
  for (let i = 0;i < 28; i = i + 7) {
    const shift = lo >>> i;
    const hasNext = !(shift >>> 7 == 0 && hi == 0);
    const byte = (hasNext ? shift | 128 : shift) & 255;
    bytes.push(byte);
    if (!hasNext) {
      return;
    }
  }
  const splitBits = lo >>> 28 & 15 | (hi & 7) << 4;
  const hasMoreBits = !(hi >> 3 == 0);
  bytes.push((hasMoreBits ? splitBits | 128 : splitBits) & 255);
  if (!hasMoreBits) {
    return;
  }
  for (let i = 3;i < 31; i = i + 7) {
    const shift = hi >>> i;
    const hasNext = !(shift >>> 7 == 0);
    const byte = (hasNext ? shift | 128 : shift) & 255;
    bytes.push(byte);
    if (!hasNext) {
      return;
    }
  }
  bytes.push(hi >>> 31 & 1);
}
var TWO_PWR_32_DBL = 4294967296;
function int64FromString(dec) {
  const minus = dec[0] === "-";
  if (minus) {
    dec = dec.slice(1);
  }
  const base = 1e6;
  let lowBits = 0;
  let highBits = 0;
  function add1e6digit(begin, end) {
    const digit1e6 = Number(dec.slice(begin, end));
    highBits *= base;
    lowBits = lowBits * base + digit1e6;
    if (lowBits >= TWO_PWR_32_DBL) {
      highBits = highBits + (lowBits / TWO_PWR_32_DBL | 0);
      lowBits = lowBits % TWO_PWR_32_DBL;
    }
  }
  add1e6digit(-24, -18);
  add1e6digit(-18, -12);
  add1e6digit(-12, -6);
  add1e6digit(-6);
  return minus ? negate(lowBits, highBits) : newBits(lowBits, highBits);
}
function int64ToString(lo, hi) {
  let bits = newBits(lo, hi);
  const negative = bits.hi & 2147483648;
  if (negative) {
    bits = negate(bits.lo, bits.hi);
  }
  const result = uInt64ToString(bits.lo, bits.hi);
  return negative ? "-" + result : result;
}
function uInt64ToString(lo, hi) {
  ({ lo, hi } = toUnsigned(lo, hi));
  if (hi <= 2097151) {
    return String(TWO_PWR_32_DBL * hi + lo);
  }
  const low = lo & 16777215;
  const mid = (lo >>> 24 | hi << 8) & 16777215;
  const high = hi >> 16 & 65535;
  let digitA = low + mid * 6777216 + high * 6710656;
  let digitB = mid + high * 8147497;
  let digitC = high * 2;
  const base = 1e7;
  if (digitA >= base) {
    digitB += Math.floor(digitA / base);
    digitA %= base;
  }
  if (digitB >= base) {
    digitC += Math.floor(digitB / base);
    digitB %= base;
  }
  return digitC.toString() + decimalFrom1e7WithLeadingZeros(digitB) + decimalFrom1e7WithLeadingZeros(digitA);
}
function toUnsigned(lo, hi) {
  return { lo: lo >>> 0, hi: hi >>> 0 };
}
function newBits(lo, hi) {
  return { lo: lo | 0, hi: hi | 0 };
}
function negate(lowBits, highBits) {
  highBits = ~highBits;
  if (lowBits) {
    lowBits = ~lowBits + 1;
  } else {
    highBits += 1;
  }
  return newBits(lowBits, highBits);
}
var decimalFrom1e7WithLeadingZeros = (digit1e7) => {
  const partial = String(digit1e7);
  return "0000000".slice(partial.length) + partial;
};
function varint32write(value, bytes) {
  if (value >= 0) {
    while (value > 127) {
      bytes.push(value & 127 | 128);
      value = value >>> 7;
    }
    bytes.push(value);
  } else {
    for (let i = 0;i < 9; i++) {
      bytes.push(value & 127 | 128);
      value = value >> 7;
    }
    bytes.push(1);
  }
}
function varint32read() {
  let b = this.buf[this.pos++];
  let result = b & 127;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 127) << 7;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 127) << 14;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 127) << 21;
  if ((b & 128) == 0) {
    this.assertBounds();
    return result;
  }
  b = this.buf[this.pos++];
  result |= (b & 15) << 28;
  for (let readBytes = 5;(b & 128) !== 0 && readBytes < 10; readBytes++)
    b = this.buf[this.pos++];
  if ((b & 128) != 0)
    throw new Error("invalid varint");
  this.assertBounds();
  return result >>> 0;
}

// node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js
var protoInt64 = /* @__PURE__ */ makeInt64Support();
function makeInt64Support() {
  const dv = new DataView(new ArrayBuffer(8));
  const ok = typeof BigInt === "function" && typeof dv.getBigInt64 === "function" && typeof dv.getBigUint64 === "function" && typeof dv.setBigInt64 === "function" && typeof dv.setBigUint64 === "function" && (!!globalThis.Deno || typeof process != "object" || typeof process.env != "object" || process.env.BUF_BIGINT_DISABLE !== "1");
  if (ok) {
    const MIN = BigInt("-9223372036854775808");
    const MAX = BigInt("9223372036854775807");
    const UMIN = BigInt("0");
    const UMAX = BigInt("18446744073709551615");
    return {
      zero: BigInt(0),
      supported: true,
      parse(value) {
        const bi = typeof value == "bigint" ? value : BigInt(value);
        if (bi > MAX || bi < MIN) {
          throw new Error(`invalid int64: ${value}`);
        }
        return bi;
      },
      uParse(value) {
        const bi = typeof value == "bigint" ? value : BigInt(value);
        if (bi > UMAX || bi < UMIN) {
          throw new Error(`invalid uint64: ${value}`);
        }
        return bi;
      },
      enc(value) {
        dv.setBigInt64(0, this.parse(value), true);
        return {
          lo: dv.getInt32(0, true),
          hi: dv.getInt32(4, true)
        };
      },
      uEnc(value) {
        dv.setBigInt64(0, this.uParse(value), true);
        return {
          lo: dv.getInt32(0, true),
          hi: dv.getInt32(4, true)
        };
      },
      dec(lo, hi) {
        dv.setInt32(0, lo, true);
        dv.setInt32(4, hi, true);
        return dv.getBigInt64(0, true);
      },
      uDec(lo, hi) {
        dv.setInt32(0, lo, true);
        dv.setInt32(4, hi, true);
        return dv.getBigUint64(0, true);
      }
    };
  }
  return {
    zero: "0",
    supported: false,
    parse(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertInt64String(value);
      return value;
    },
    uParse(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertUInt64String(value);
      return value;
    },
    enc(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertInt64String(value);
      return int64FromString(value);
    },
    uEnc(value) {
      if (typeof value != "string") {
        value = value.toString();
      }
      assertUInt64String(value);
      return int64FromString(value);
    },
    dec(lo, hi) {
      return int64ToString(lo, hi);
    },
    uDec(lo, hi) {
      return uInt64ToString(lo, hi);
    }
  };
}
function assertInt64String(value) {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error("invalid int64: " + value);
  }
}
function assertUInt64String(value) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("invalid uint64: " + value);
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/scalar.js
function scalarZeroValue(type, longAsString) {
  switch (type) {
    case ScalarType.STRING:
      return "";
    case ScalarType.BOOL:
      return false;
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return 0;
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SFIXED64:
    case ScalarType.FIXED64:
    case ScalarType.SINT64:
      return longAsString ? "0" : protoInt64.zero;
    case ScalarType.BYTES:
      return new Uint8Array(0);
    default:
      return 0;
  }
}
function isScalarZeroValue(type, value) {
  switch (type) {
    case ScalarType.BOOL:
      return value === false;
    case ScalarType.STRING:
      return value === "";
    case ScalarType.BYTES:
      return value instanceof Uint8Array && !value.byteLength;
    default:
      return value == 0;
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/unsafe.js
var IMPLICIT = 2;
var unsafeLocal = Symbol.for("reflect unsafe local");
function unsafeOneofCase(target, oneof) {
  const c = target[oneof.localName].case;
  if (c === undefined) {
    return c;
  }
  return oneof.fields.find((f) => f.localName === c);
}
function unsafeIsSet(target, field) {
  const name = field.localName;
  if (field.oneof) {
    return target[field.oneof.localName].case === name;
  }
  if (field.presence != IMPLICIT) {
    return target[name] !== undefined && Object.prototype.hasOwnProperty.call(target, name);
  }
  switch (field.fieldKind) {
    case "list":
      return target[name].length > 0;
    case "map":
      return Object.keys(target[name]).length > 0;
    case "scalar":
      return !isScalarZeroValue(field.scalar, target[name]);
    case "enum":
      return target[name] !== field.enum.values[0].number;
  }
  throw new Error("message field with implicit presence");
}
function unsafeIsSetExplicit(target, localName) {
  return Object.prototype.hasOwnProperty.call(target, localName) && target[localName] !== undefined;
}
function unsafeGet(target, field) {
  if (field.oneof) {
    const oneof = target[field.oneof.localName];
    if (oneof.case === field.localName) {
      return oneof.value;
    }
    return;
  }
  return target[field.localName];
}
function unsafeSet(target, field, value) {
  if (field.oneof) {
    target[field.oneof.localName] = {
      case: field.localName,
      value
    };
  } else {
    target[field.localName] = value;
  }
}
function unsafeClear(target, field) {
  const name = field.localName;
  if (field.oneof) {
    const oneofLocalName = field.oneof.localName;
    if (target[oneofLocalName].case === name) {
      target[oneofLocalName] = { case: undefined };
    }
  } else if (field.presence != IMPLICIT) {
    delete target[name];
  } else {
    switch (field.fieldKind) {
      case "map":
        target[name] = {};
        break;
      case "list":
        target[name] = [];
        break;
      case "enum":
        target[name] = field.enum.values[0].number;
        break;
      case "scalar":
        target[name] = scalarZeroValue(field.scalar, field.longAsString);
        break;
    }
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/guard.js
function isObject(arg) {
  return arg !== null && typeof arg == "object" && !Array.isArray(arg);
}
function isReflectList(arg, field) {
  var _a, _b, _c, _d;
  if (isObject(arg) && unsafeLocal in arg && "add" in arg && "field" in arg && typeof arg.field == "function") {
    if (field !== undefined) {
      const a = field;
      const b = arg.field();
      return a.listKind == b.listKind && a.scalar === b.scalar && ((_a = a.message) === null || _a === undefined ? undefined : _a.typeName) === ((_b = b.message) === null || _b === undefined ? undefined : _b.typeName) && ((_c = a.enum) === null || _c === undefined ? undefined : _c.typeName) === ((_d = b.enum) === null || _d === undefined ? undefined : _d.typeName);
    }
    return true;
  }
  return false;
}
function isReflectMap(arg, field) {
  var _a, _b, _c, _d;
  if (isObject(arg) && unsafeLocal in arg && "has" in arg && "field" in arg && typeof arg.field == "function") {
    if (field !== undefined) {
      const a = field, b = arg.field();
      return a.mapKey === b.mapKey && a.mapKind == b.mapKind && a.scalar === b.scalar && ((_a = a.message) === null || _a === undefined ? undefined : _a.typeName) === ((_b = b.message) === null || _b === undefined ? undefined : _b.typeName) && ((_c = a.enum) === null || _c === undefined ? undefined : _c.typeName) === ((_d = b.enum) === null || _d === undefined ? undefined : _d.typeName);
    }
    return true;
  }
  return false;
}
function isReflectMessage(arg, messageDesc) {
  return isObject(arg) && unsafeLocal in arg && "desc" in arg && isObject(arg.desc) && arg.desc.kind === "message" && (messageDesc === undefined || arg.desc.typeName == messageDesc.typeName);
}

// node_modules/@bufbuild/protobuf/dist/esm/wkt/wrappers.js
function isWrapper(arg) {
  return isWrapperTypeName(arg.$typeName);
}
function isWrapperDesc(messageDesc) {
  const f = messageDesc.fields[0];
  return isWrapperTypeName(messageDesc.typeName) && f !== undefined && f.fieldKind == "scalar" && f.name == "value" && f.number == 1;
}
function isWrapperTypeName(name) {
  return name.startsWith("google.protobuf.") && [
    "DoubleValue",
    "FloatValue",
    "Int64Value",
    "UInt64Value",
    "Int32Value",
    "UInt32Value",
    "BoolValue",
    "StringValue",
    "BytesValue"
  ].includes(name.substring(16));
}

// node_modules/@bufbuild/protobuf/dist/esm/create.js
var EDITION_PROTO3 = 999;
var EDITION_PROTO2 = 998;
var IMPLICIT2 = 2;
function create(schema, init) {
  if (isMessage(init, schema)) {
    return init;
  }
  const message = createZeroMessage(schema);
  if (init !== undefined) {
    initMessage(schema, message, init);
  }
  return message;
}
function initMessage(messageDesc, message, init) {
  for (const member of messageDesc.members) {
    let value = init[member.localName];
    if (value == null) {
      continue;
    }
    let field;
    if (member.kind == "oneof") {
      const oneofField = unsafeOneofCase(init, member);
      if (!oneofField) {
        continue;
      }
      field = oneofField;
      value = unsafeGet(init, oneofField);
    } else {
      field = member;
    }
    switch (field.fieldKind) {
      case "message":
        value = toMessage(field, value);
        break;
      case "scalar":
        value = initScalar(field, value);
        break;
      case "list":
        value = initList(field, value);
        break;
      case "map":
        value = initMap(field, value);
        break;
    }
    unsafeSet(message, field, value);
  }
  return message;
}
function initScalar(field, value) {
  if (field.scalar == ScalarType.BYTES) {
    return toU8Arr(value);
  }
  return value;
}
function initMap(field, value) {
  if (isObject(value)) {
    if (field.scalar == ScalarType.BYTES) {
      return convertObjectValues(value, toU8Arr);
    }
    if (field.mapKind == "message") {
      return convertObjectValues(value, (val) => toMessage(field, val));
    }
  }
  return value;
}
function initList(field, value) {
  if (Array.isArray(value)) {
    if (field.scalar == ScalarType.BYTES) {
      return value.map(toU8Arr);
    }
    if (field.listKind == "message") {
      return value.map((item) => toMessage(field, item));
    }
  }
  return value;
}
function toMessage(field, value) {
  if (field.fieldKind == "message" && !field.oneof && isWrapperDesc(field.message)) {
    return initScalar(field.message.fields[0], value);
  }
  if (isObject(value)) {
    if (field.message.typeName == "google.protobuf.Struct" && field.parent.typeName !== "google.protobuf.Value") {
      return value;
    }
    if (!isMessage(value, field.message)) {
      return create(field.message, value);
    }
  }
  return value;
}
function toU8Arr(value) {
  return Array.isArray(value) ? new Uint8Array(value) : value;
}
function convertObjectValues(obj, fn) {
  const ret = {};
  for (const entry of Object.entries(obj)) {
    ret[entry[0]] = fn(entry[1]);
  }
  return ret;
}
var tokenZeroMessageField = Symbol();
var messagePrototypes = new WeakMap;
function createZeroMessage(desc) {
  let msg;
  if (!needsPrototypeChain(desc)) {
    msg = {
      $typeName: desc.typeName
    };
    for (const member of desc.members) {
      if (member.kind == "oneof" || member.presence == IMPLICIT2) {
        msg[member.localName] = createZeroField(member);
      }
    }
  } else {
    const cached = messagePrototypes.get(desc);
    let prototype;
    let members;
    if (cached) {
      ({ prototype, members } = cached);
    } else {
      prototype = {};
      members = new Set;
      for (const member of desc.members) {
        if (member.kind == "oneof") {
          continue;
        }
        if (member.fieldKind != "scalar" && member.fieldKind != "enum") {
          continue;
        }
        if (member.presence == IMPLICIT2) {
          continue;
        }
        members.add(member);
        prototype[member.localName] = createZeroField(member);
      }
      messagePrototypes.set(desc, { prototype, members });
    }
    msg = Object.create(prototype);
    msg.$typeName = desc.typeName;
    for (const member of desc.members) {
      if (members.has(member)) {
        continue;
      }
      if (member.kind == "field") {
        if (member.fieldKind == "message") {
          continue;
        }
        if (member.fieldKind == "scalar" || member.fieldKind == "enum") {
          if (member.presence != IMPLICIT2) {
            continue;
          }
        }
      }
      msg[member.localName] = createZeroField(member);
    }
  }
  return msg;
}
function needsPrototypeChain(desc) {
  switch (desc.file.edition) {
    case EDITION_PROTO3:
      return false;
    case EDITION_PROTO2:
      return true;
    default:
      return desc.fields.some((f) => f.presence != IMPLICIT2 && f.fieldKind != "message" && !f.oneof);
  }
}
function createZeroField(field) {
  if (field.kind == "oneof") {
    return { case: undefined };
  }
  if (field.fieldKind == "list") {
    return [];
  }
  if (field.fieldKind == "map") {
    return {};
  }
  if (field.fieldKind == "message") {
    return tokenZeroMessageField;
  }
  const defaultValue = field.getDefaultValue();
  if (defaultValue !== undefined) {
    return field.fieldKind == "scalar" && field.longAsString ? defaultValue.toString() : defaultValue;
  }
  return field.fieldKind == "scalar" ? scalarZeroValue(field.scalar, field.longAsString) : field.enum.values[0].number;
}
// node_modules/@bufbuild/protobuf/dist/esm/reflect/error.js
var errorNames = [
  "FieldValueInvalidError",
  "FieldListRangeError",
  "ForeignFieldError"
];

class FieldError extends Error {
  constructor(fieldOrOneof, message, name = "FieldValueInvalidError") {
    super(message);
    this.name = name;
    this.field = () => fieldOrOneof;
  }
}
function isFieldError(arg) {
  return arg instanceof Error && errorNames.includes(arg.name) && "field" in arg && typeof arg.field == "function";
}

// node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js
var symbol = Symbol.for("@bufbuild/protobuf/text-encoding");
function getTextEncoding() {
  if (globalThis[symbol] == undefined) {
    const te = new globalThis.TextEncoder;
    const td = new globalThis.TextDecoder;
    globalThis[symbol] = {
      encodeUtf8(text) {
        return te.encode(text);
      },
      decodeUtf8(bytes) {
        return td.decode(bytes);
      },
      checkUtf8(text) {
        try {
          encodeURIComponent(text);
          return true;
        } catch (_) {
          return false;
        }
      }
    };
  }
  return globalThis[symbol];
}

// node_modules/@bufbuild/protobuf/dist/esm/wire/binary-encoding.js
var WireType;
(function(WireType2) {
  WireType2[WireType2["Varint"] = 0] = "Varint";
  WireType2[WireType2["Bit64"] = 1] = "Bit64";
  WireType2[WireType2["LengthDelimited"] = 2] = "LengthDelimited";
  WireType2[WireType2["StartGroup"] = 3] = "StartGroup";
  WireType2[WireType2["EndGroup"] = 4] = "EndGroup";
  WireType2[WireType2["Bit32"] = 5] = "Bit32";
})(WireType || (WireType = {}));
var FLOAT32_MAX = 340282346638528860000000000000000000000;
var FLOAT32_MIN = -340282346638528860000000000000000000000;
var UINT32_MAX = 4294967295;
var INT32_MAX = 2147483647;
var INT32_MIN = -2147483648;

class BinaryWriter {
  constructor(encodeUtf8 = getTextEncoding().encodeUtf8) {
    this.encodeUtf8 = encodeUtf8;
    this.stack = [];
    this.chunks = [];
    this.buf = [];
  }
  finish() {
    if (this.buf.length) {
      this.chunks.push(new Uint8Array(this.buf));
      this.buf = [];
    }
    let len = 0;
    for (let i = 0;i < this.chunks.length; i++)
      len += this.chunks[i].length;
    let bytes = new Uint8Array(len);
    let offset = 0;
    for (let i = 0;i < this.chunks.length; i++) {
      bytes.set(this.chunks[i], offset);
      offset += this.chunks[i].length;
    }
    this.chunks = [];
    return bytes;
  }
  fork() {
    this.stack.push({ chunks: this.chunks, buf: this.buf });
    this.chunks = [];
    this.buf = [];
    return this;
  }
  join() {
    let chunk = this.finish();
    let prev = this.stack.pop();
    if (!prev)
      throw new Error("invalid state, fork stack empty");
    this.chunks = prev.chunks;
    this.buf = prev.buf;
    this.uint32(chunk.byteLength);
    return this.raw(chunk);
  }
  tag(fieldNo, type) {
    return this.uint32((fieldNo << 3 | type) >>> 0);
  }
  raw(chunk) {
    if (this.buf.length) {
      this.chunks.push(new Uint8Array(this.buf));
      this.buf = [];
    }
    this.chunks.push(chunk);
    return this;
  }
  uint32(value) {
    assertUInt32(value);
    while (value > 127) {
      this.buf.push(value & 127 | 128);
      value = value >>> 7;
    }
    this.buf.push(value);
    return this;
  }
  int32(value) {
    assertInt32(value);
    varint32write(value, this.buf);
    return this;
  }
  bool(value) {
    this.buf.push(value ? 1 : 0);
    return this;
  }
  bytes(value) {
    this.uint32(value.byteLength);
    return this.raw(value);
  }
  string(value) {
    let chunk = this.encodeUtf8(value);
    this.uint32(chunk.byteLength);
    return this.raw(chunk);
  }
  float(value) {
    assertFloat32(value);
    let chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setFloat32(0, value, true);
    return this.raw(chunk);
  }
  double(value) {
    let chunk = new Uint8Array(8);
    new DataView(chunk.buffer).setFloat64(0, value, true);
    return this.raw(chunk);
  }
  fixed32(value) {
    assertUInt32(value);
    let chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setUint32(0, value, true);
    return this.raw(chunk);
  }
  sfixed32(value) {
    assertInt32(value);
    let chunk = new Uint8Array(4);
    new DataView(chunk.buffer).setInt32(0, value, true);
    return this.raw(chunk);
  }
  sint32(value) {
    assertInt32(value);
    value = (value << 1 ^ value >> 31) >>> 0;
    varint32write(value, this.buf);
    return this;
  }
  sfixed64(value) {
    let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.enc(value);
    view.setInt32(0, tc.lo, true);
    view.setInt32(4, tc.hi, true);
    return this.raw(chunk);
  }
  fixed64(value) {
    let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.uEnc(value);
    view.setInt32(0, tc.lo, true);
    view.setInt32(4, tc.hi, true);
    return this.raw(chunk);
  }
  int64(value) {
    let tc = protoInt64.enc(value);
    varint64write(tc.lo, tc.hi, this.buf);
    return this;
  }
  sint64(value) {
    const tc = protoInt64.enc(value), sign = tc.hi >> 31, lo = tc.lo << 1 ^ sign, hi = (tc.hi << 1 | tc.lo >>> 31) ^ sign;
    varint64write(lo, hi, this.buf);
    return this;
  }
  uint64(value) {
    const tc = protoInt64.uEnc(value);
    varint64write(tc.lo, tc.hi, this.buf);
    return this;
  }
}

class BinaryReader {
  constructor(buf, decodeUtf8 = getTextEncoding().decodeUtf8) {
    this.decodeUtf8 = decodeUtf8;
    this.varint64 = varint64read;
    this.uint32 = varint32read;
    this.buf = buf;
    this.len = buf.length;
    this.pos = 0;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  tag() {
    let tag = this.uint32(), fieldNo = tag >>> 3, wireType = tag & 7;
    if (fieldNo <= 0 || wireType < 0 || wireType > 5)
      throw new Error("illegal tag: field no " + fieldNo + " wire type " + wireType);
    return [fieldNo, wireType];
  }
  skip(wireType, fieldNo) {
    let start = this.pos;
    switch (wireType) {
      case WireType.Varint:
        while (this.buf[this.pos++] & 128) {}
        break;
      case WireType.Bit64:
        this.pos += 4;
      case WireType.Bit32:
        this.pos += 4;
        break;
      case WireType.LengthDelimited:
        let len = this.uint32();
        this.pos += len;
        break;
      case WireType.StartGroup:
        for (;; ) {
          const [fn, wt] = this.tag();
          if (wt === WireType.EndGroup) {
            if (fieldNo !== undefined && fn !== fieldNo) {
              throw new Error("invalid end group tag");
            }
            break;
          }
          this.skip(wt, fn);
        }
        break;
      default:
        throw new Error("cant skip wire type " + wireType);
    }
    this.assertBounds();
    return this.buf.subarray(start, this.pos);
  }
  assertBounds() {
    if (this.pos > this.len)
      throw new RangeError("premature EOF");
  }
  int32() {
    return this.uint32() | 0;
  }
  sint32() {
    let zze = this.uint32();
    return zze >>> 1 ^ -(zze & 1);
  }
  int64() {
    return protoInt64.dec(...this.varint64());
  }
  uint64() {
    return protoInt64.uDec(...this.varint64());
  }
  sint64() {
    let [lo, hi] = this.varint64();
    let s = -(lo & 1);
    lo = (lo >>> 1 | (hi & 1) << 31) ^ s;
    hi = hi >>> 1 ^ s;
    return protoInt64.dec(lo, hi);
  }
  bool() {
    let [lo, hi] = this.varint64();
    return lo !== 0 || hi !== 0;
  }
  fixed32() {
    return this.view.getUint32((this.pos += 4) - 4, true);
  }
  sfixed32() {
    return this.view.getInt32((this.pos += 4) - 4, true);
  }
  fixed64() {
    return protoInt64.uDec(this.sfixed32(), this.sfixed32());
  }
  sfixed64() {
    return protoInt64.dec(this.sfixed32(), this.sfixed32());
  }
  float() {
    return this.view.getFloat32((this.pos += 4) - 4, true);
  }
  double() {
    return this.view.getFloat64((this.pos += 8) - 8, true);
  }
  bytes() {
    let len = this.uint32(), start = this.pos;
    this.pos += len;
    this.assertBounds();
    return this.buf.subarray(start, start + len);
  }
  string() {
    return this.decodeUtf8(this.bytes());
  }
}
function assertInt32(arg) {
  if (typeof arg == "string") {
    arg = Number(arg);
  } else if (typeof arg != "number") {
    throw new Error("invalid int32: " + typeof arg);
  }
  if (!Number.isInteger(arg) || arg > INT32_MAX || arg < INT32_MIN)
    throw new Error("invalid int32: " + arg);
}
function assertUInt32(arg) {
  if (typeof arg == "string") {
    arg = Number(arg);
  } else if (typeof arg != "number") {
    throw new Error("invalid uint32: " + typeof arg);
  }
  if (!Number.isInteger(arg) || arg > UINT32_MAX || arg < 0)
    throw new Error("invalid uint32: " + arg);
}
function assertFloat32(arg) {
  if (typeof arg == "string") {
    const o = arg;
    arg = Number(arg);
    if (Number.isNaN(arg) && o !== "NaN") {
      throw new Error("invalid float32: " + o);
    }
  } else if (typeof arg != "number") {
    throw new Error("invalid float32: " + typeof arg);
  }
  if (Number.isFinite(arg) && (arg > FLOAT32_MAX || arg < FLOAT32_MIN))
    throw new Error("invalid float32: " + arg);
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect-check.js
function checkField(field, value) {
  const check = field.fieldKind == "list" ? isReflectList(value, field) : field.fieldKind == "map" ? isReflectMap(value, field) : checkSingular(field, value);
  if (check === true) {
    return;
  }
  let reason;
  switch (field.fieldKind) {
    case "list":
      reason = `expected ${formatReflectList(field)}, got ${formatVal(value)}`;
      break;
    case "map":
      reason = `expected ${formatReflectMap(field)}, got ${formatVal(value)}`;
      break;
    default: {
      reason = reasonSingular(field, value, check);
    }
  }
  return new FieldError(field, reason);
}
function checkListItem(field, index, value) {
  const check = checkSingular(field, value);
  if (check !== true) {
    return new FieldError(field, `list item #${index + 1}: ${reasonSingular(field, value, check)}`);
  }
  return;
}
function checkMapEntry(field, key, value) {
  const checkKey = checkScalarValue(key, field.mapKey);
  if (checkKey !== true) {
    return new FieldError(field, `invalid map key: ${reasonSingular({ scalar: field.mapKey }, key, checkKey)}`);
  }
  const checkVal = checkSingular(field, value);
  if (checkVal !== true) {
    return new FieldError(field, `map entry ${formatVal(key)}: ${reasonSingular(field, value, checkVal)}`);
  }
  return;
}
function checkSingular(field, value) {
  if (field.scalar !== undefined) {
    return checkScalarValue(value, field.scalar);
  }
  if (field.enum !== undefined) {
    if (field.enum.open) {
      return Number.isInteger(value);
    }
    return field.enum.values.some((v) => v.number === value);
  }
  return isReflectMessage(value, field.message);
}
function checkScalarValue(value, scalar) {
  switch (scalar) {
    case ScalarType.DOUBLE:
      return typeof value == "number";
    case ScalarType.FLOAT:
      if (typeof value != "number") {
        return false;
      }
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        return true;
      }
      if (value > FLOAT32_MAX || value < FLOAT32_MIN) {
        return `${value.toFixed()} out of range`;
      }
      return true;
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return false;
      }
      if (value > INT32_MAX || value < INT32_MIN) {
        return `${value.toFixed()} out of range`;
      }
      return true;
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return false;
      }
      if (value > UINT32_MAX || value < 0) {
        return `${value.toFixed()} out of range`;
      }
      return true;
    case ScalarType.BOOL:
      return typeof value == "boolean";
    case ScalarType.STRING:
      if (typeof value != "string") {
        return false;
      }
      return getTextEncoding().checkUtf8(value) || "invalid UTF8";
    case ScalarType.BYTES:
      return value instanceof Uint8Array;
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) {
        try {
          protoInt64.parse(value);
          return true;
        } catch (_) {
          return `${value} out of range`;
        }
      }
      return false;
    case ScalarType.FIXED64:
    case ScalarType.UINT64:
      if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) {
        try {
          protoInt64.uParse(value);
          return true;
        } catch (_) {
          return `${value} out of range`;
        }
      }
      return false;
  }
}
function reasonSingular(field, val, details) {
  details = typeof details == "string" ? `: ${details}` : `, got ${formatVal(val)}`;
  if (field.scalar !== undefined) {
    return `expected ${scalarTypeDescription(field.scalar)}` + details;
  }
  if (field.enum !== undefined) {
    return `expected ${field.enum.toString()}` + details;
  }
  return `expected ${formatReflectMessage(field.message)}` + details;
}
function formatVal(val) {
  switch (typeof val) {
    case "object":
      if (val === null) {
        return "null";
      }
      if (val instanceof Uint8Array) {
        return `Uint8Array(${val.length})`;
      }
      if (Array.isArray(val)) {
        return `Array(${val.length})`;
      }
      if (isReflectList(val)) {
        return formatReflectList(val.field());
      }
      if (isReflectMap(val)) {
        return formatReflectMap(val.field());
      }
      if (isReflectMessage(val)) {
        return formatReflectMessage(val.desc);
      }
      if (isMessage(val)) {
        return `message ${val.$typeName}`;
      }
      return "object";
    case "string":
      return val.length > 30 ? "string" : `"${val.split('"').join("\\\"")}"`;
    case "boolean":
      return String(val);
    case "number":
      return String(val);
    case "bigint":
      return String(val) + "n";
    default:
      return typeof val;
  }
}
function formatReflectMessage(desc) {
  return `ReflectMessage (${desc.typeName})`;
}
function formatReflectList(field) {
  switch (field.listKind) {
    case "message":
      return `ReflectList (${field.message.toString()})`;
    case "enum":
      return `ReflectList (${field.enum.toString()})`;
    case "scalar":
      return `ReflectList (${ScalarType[field.scalar]})`;
  }
}
function formatReflectMap(field) {
  switch (field.mapKind) {
    case "message":
      return `ReflectMap (${ScalarType[field.mapKey]}, ${field.message.toString()})`;
    case "enum":
      return `ReflectMap (${ScalarType[field.mapKey]}, ${field.enum.toString()})`;
    case "scalar":
      return `ReflectMap (${ScalarType[field.mapKey]}, ${ScalarType[field.scalar]})`;
  }
}
function scalarTypeDescription(scalar) {
  switch (scalar) {
    case ScalarType.STRING:
      return "string";
    case ScalarType.BOOL:
      return "boolean";
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return "bigint (int64)";
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return "bigint (uint64)";
    case ScalarType.BYTES:
      return "Uint8Array";
    case ScalarType.DOUBLE:
      return "number (float64)";
    case ScalarType.FLOAT:
      return "number (float32)";
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
      return "number (uint32)";
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      return "number (int32)";
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect.js
function reflect(messageDesc, message, check = true) {
  return new ReflectMessageImpl(messageDesc, message, check);
}
var messageSortedFields = new WeakMap;

class ReflectMessageImpl {
  get sortedFields() {
    const cached = messageSortedFields.get(this.desc);
    if (cached) {
      return cached;
    }
    const sortedFields = this.desc.fields.concat().sort((a, b) => a.number - b.number);
    messageSortedFields.set(this.desc, sortedFields);
    return sortedFields;
  }
  constructor(messageDesc, message, check = true) {
    this.lists = new Map;
    this.maps = new Map;
    this.check = check;
    this.desc = messageDesc;
    this.message = this[unsafeLocal] = message !== null && message !== undefined ? message : create(messageDesc);
    this.fields = messageDesc.fields;
    this.oneofs = messageDesc.oneofs;
    this.members = messageDesc.members;
  }
  findNumber(number) {
    if (!this._fieldsByNumber) {
      this._fieldsByNumber = new Map(this.desc.fields.map((f) => [f.number, f]));
    }
    return this._fieldsByNumber.get(number);
  }
  oneofCase(oneof) {
    assertOwn(this.message, oneof);
    return unsafeOneofCase(this.message, oneof);
  }
  isSet(field) {
    assertOwn(this.message, field);
    return unsafeIsSet(this.message, field);
  }
  clear(field) {
    assertOwn(this.message, field);
    unsafeClear(this.message, field);
  }
  get(field) {
    assertOwn(this.message, field);
    const value = unsafeGet(this.message, field);
    switch (field.fieldKind) {
      case "list":
        let list = this.lists.get(field);
        if (!list || list[unsafeLocal] !== value) {
          this.lists.set(field, list = new ReflectListImpl(field, value, this.check));
        }
        return list;
      case "map":
        let map = this.maps.get(field);
        if (!map || map[unsafeLocal] !== value) {
          this.maps.set(field, map = new ReflectMapImpl(field, value, this.check));
        }
        return map;
      case "message":
        return messageToReflect(field, value, this.check);
      case "scalar":
        return value === undefined ? scalarZeroValue(field.scalar, false) : longToReflect(field, value);
      case "enum":
        return value !== null && value !== undefined ? value : field.enum.values[0].number;
    }
  }
  set(field, value) {
    assertOwn(this.message, field);
    if (this.check) {
      const err = checkField(field, value);
      if (err) {
        throw err;
      }
    }
    let local;
    if (field.fieldKind == "message") {
      local = messageToLocal(field, value);
    } else if (isReflectMap(value) || isReflectList(value)) {
      local = value[unsafeLocal];
    } else {
      local = longToLocal(field, value);
    }
    unsafeSet(this.message, field, local);
  }
  getUnknown() {
    return this.message.$unknown;
  }
  setUnknown(value) {
    this.message.$unknown = value;
  }
}
function assertOwn(owner, member) {
  if (member.parent.typeName !== owner.$typeName) {
    throw new FieldError(member, `cannot use ${member.toString()} with message ${owner.$typeName}`, "ForeignFieldError");
  }
}
class ReflectListImpl {
  field() {
    return this._field;
  }
  get size() {
    return this._arr.length;
  }
  constructor(field, unsafeInput, check) {
    this._field = field;
    this._arr = this[unsafeLocal] = unsafeInput;
    this.check = check;
  }
  get(index) {
    const item = this._arr[index];
    return item === undefined ? undefined : listItemToReflect(this._field, item, this.check);
  }
  set(index, item) {
    if (index < 0 || index >= this._arr.length) {
      throw new FieldError(this._field, `list item #${index + 1}: out of range`);
    }
    if (this.check) {
      const err = checkListItem(this._field, index, item);
      if (err) {
        throw err;
      }
    }
    this._arr[index] = listItemToLocal(this._field, item);
  }
  add(item) {
    if (this.check) {
      const err = checkListItem(this._field, this._arr.length, item);
      if (err) {
        throw err;
      }
    }
    this._arr.push(listItemToLocal(this._field, item));
    return;
  }
  clear() {
    this._arr.splice(0, this._arr.length);
  }
  [Symbol.iterator]() {
    return this.values();
  }
  keys() {
    return this._arr.keys();
  }
  *values() {
    for (const item of this._arr) {
      yield listItemToReflect(this._field, item, this.check);
    }
  }
  *entries() {
    for (let i = 0;i < this._arr.length; i++) {
      yield [i, listItemToReflect(this._field, this._arr[i], this.check)];
    }
  }
}
class ReflectMapImpl {
  constructor(field, unsafeInput, check = true) {
    this.obj = this[unsafeLocal] = unsafeInput !== null && unsafeInput !== undefined ? unsafeInput : {};
    this.check = check;
    this._field = field;
  }
  field() {
    return this._field;
  }
  set(key, value) {
    if (this.check) {
      const err = checkMapEntry(this._field, key, value);
      if (err) {
        throw err;
      }
    }
    this.obj[mapKeyToLocal(key)] = mapValueToLocal(this._field, value);
    return this;
  }
  delete(key) {
    const k = mapKeyToLocal(key);
    const has = Object.prototype.hasOwnProperty.call(this.obj, k);
    if (has) {
      delete this.obj[k];
    }
    return has;
  }
  clear() {
    for (const key of Object.keys(this.obj)) {
      delete this.obj[key];
    }
  }
  get(key) {
    let val = this.obj[mapKeyToLocal(key)];
    if (val !== undefined) {
      val = mapValueToReflect(this._field, val, this.check);
    }
    return val;
  }
  has(key) {
    return Object.prototype.hasOwnProperty.call(this.obj, mapKeyToLocal(key));
  }
  *keys() {
    for (const objKey of Object.keys(this.obj)) {
      yield mapKeyToReflect(objKey, this._field.mapKey);
    }
  }
  *entries() {
    for (const objEntry of Object.entries(this.obj)) {
      yield [
        mapKeyToReflect(objEntry[0], this._field.mapKey),
        mapValueToReflect(this._field, objEntry[1], this.check)
      ];
    }
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  get size() {
    return Object.keys(this.obj).length;
  }
  *values() {
    for (const val of Object.values(this.obj)) {
      yield mapValueToReflect(this._field, val, this.check);
    }
  }
  forEach(callbackfn, thisArg) {
    for (const mapEntry of this.entries()) {
      callbackfn.call(thisArg, mapEntry[1], mapEntry[0], this);
    }
  }
}
function messageToLocal(field, value) {
  if (!isReflectMessage(value)) {
    return value;
  }
  if (isWrapper(value.message) && !field.oneof && field.fieldKind == "message") {
    return value.message.value;
  }
  if (value.desc.typeName == "google.protobuf.Struct" && field.parent.typeName != "google.protobuf.Value") {
    return wktStructToLocal(value.message);
  }
  return value.message;
}
function messageToReflect(field, value, check) {
  if (value !== undefined) {
    if (isWrapperDesc(field.message) && !field.oneof && field.fieldKind == "message") {
      value = {
        $typeName: field.message.typeName,
        value: longToReflect(field.message.fields[0], value)
      };
    } else if (field.message.typeName == "google.protobuf.Struct" && field.parent.typeName != "google.protobuf.Value" && isObject(value)) {
      value = wktStructToReflect(value);
    }
  }
  return new ReflectMessageImpl(field.message, value, check);
}
function listItemToLocal(field, value) {
  if (field.listKind == "message") {
    return messageToLocal(field, value);
  }
  return longToLocal(field, value);
}
function listItemToReflect(field, value, check) {
  if (field.listKind == "message") {
    return messageToReflect(field, value, check);
  }
  return longToReflect(field, value);
}
function mapValueToLocal(field, value) {
  if (field.mapKind == "message") {
    return messageToLocal(field, value);
  }
  return longToLocal(field, value);
}
function mapValueToReflect(field, value, check) {
  if (field.mapKind == "message") {
    return messageToReflect(field, value, check);
  }
  return value;
}
function mapKeyToLocal(key) {
  return typeof key == "string" || typeof key == "number" ? key : String(key);
}
function mapKeyToReflect(key, type) {
  switch (type) {
    case ScalarType.STRING:
      return key;
    case ScalarType.INT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32: {
      const n = Number.parseInt(key);
      if (Number.isFinite(n)) {
        return n;
      }
      break;
    }
    case ScalarType.BOOL:
      switch (key) {
        case "true":
          return true;
        case "false":
          return false;
      }
      break;
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      try {
        return protoInt64.uParse(key);
      } catch (_a) {}
      break;
    default:
      try {
        return protoInt64.parse(key);
      } catch (_b) {}
      break;
  }
  return key;
}
function longToReflect(field, value) {
  switch (field.scalar) {
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if ("longAsString" in field && field.longAsString && typeof value == "string") {
        value = protoInt64.parse(value);
      }
      break;
    case ScalarType.FIXED64:
    case ScalarType.UINT64:
      if ("longAsString" in field && field.longAsString && typeof value == "string") {
        value = protoInt64.uParse(value);
      }
      break;
  }
  return value;
}
function longToLocal(field, value) {
  switch (field.scalar) {
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if ("longAsString" in field && field.longAsString) {
        value = String(value);
      } else if (typeof value == "string" || typeof value == "number") {
        value = protoInt64.parse(value);
      }
      break;
    case ScalarType.FIXED64:
    case ScalarType.UINT64:
      if ("longAsString" in field && field.longAsString) {
        value = String(value);
      } else if (typeof value == "string" || typeof value == "number") {
        value = protoInt64.uParse(value);
      }
      break;
  }
  return value;
}
function wktStructToReflect(json) {
  const struct = {
    $typeName: "google.protobuf.Struct",
    fields: {}
  };
  if (isObject(json)) {
    for (const [k, v] of Object.entries(json)) {
      struct.fields[k] = wktValueToReflect(v);
    }
  }
  return struct;
}
function wktStructToLocal(val) {
  const json = {};
  for (const [k, v] of Object.entries(val.fields)) {
    json[k] = wktValueToLocal(v);
  }
  return json;
}
function wktValueToLocal(val) {
  switch (val.kind.case) {
    case "structValue":
      return wktStructToLocal(val.kind.value);
    case "listValue":
      return val.kind.value.values.map(wktValueToLocal);
    case "nullValue":
    case undefined:
      return null;
    default:
      return val.kind.value;
  }
}
function wktValueToReflect(json) {
  const value = {
    $typeName: "google.protobuf.Value",
    kind: { case: undefined }
  };
  switch (typeof json) {
    case "number":
      value.kind = { case: "numberValue", value: json };
      break;
    case "string":
      value.kind = { case: "stringValue", value: json };
      break;
    case "boolean":
      value.kind = { case: "boolValue", value: json };
      break;
    case "object":
      if (json === null) {
        const nullValue = 0;
        value.kind = { case: "nullValue", value: nullValue };
      } else if (Array.isArray(json)) {
        const listValue = {
          $typeName: "google.protobuf.ListValue",
          values: []
        };
        if (Array.isArray(json)) {
          for (const e of json) {
            listValue.values.push(wktValueToReflect(e));
          }
        }
        value.kind = {
          case: "listValue",
          value: listValue
        };
      } else {
        value.kind = {
          case: "structValue",
          value: wktStructToReflect(json)
        };
      }
      break;
  }
  return value;
}
// node_modules/@bufbuild/protobuf/dist/esm/wire/base64-encoding.js
function base64Decode(base64Str) {
  const table = getDecodeTable();
  let es = base64Str.length * 3 / 4;
  if (base64Str[base64Str.length - 2] == "=")
    es -= 2;
  else if (base64Str[base64Str.length - 1] == "=")
    es -= 1;
  let bytes = new Uint8Array(es), bytePos = 0, groupPos = 0, b, p = 0;
  for (let i = 0;i < base64Str.length; i++) {
    b = table[base64Str.charCodeAt(i)];
    if (b === undefined) {
      switch (base64Str[i]) {
        case "=":
          groupPos = 0;
        case `
`:
        case "\r":
        case "\t":
        case " ":
          continue;
        default:
          throw Error("invalid base64 string");
      }
    }
    switch (groupPos) {
      case 0:
        p = b;
        groupPos = 1;
        break;
      case 1:
        bytes[bytePos++] = p << 2 | (b & 48) >> 4;
        p = b;
        groupPos = 2;
        break;
      case 2:
        bytes[bytePos++] = (p & 15) << 4 | (b & 60) >> 2;
        p = b;
        groupPos = 3;
        break;
      case 3:
        bytes[bytePos++] = (p & 3) << 6 | b;
        groupPos = 0;
        break;
    }
  }
  if (groupPos == 1)
    throw Error("invalid base64 string");
  return bytes.subarray(0, bytePos);
}
function base64Encode(bytes, encoding = "std") {
  const table = getEncodeTable(encoding);
  const pad = encoding == "std";
  let base64 = "", groupPos = 0, b, p = 0;
  for (let i = 0;i < bytes.length; i++) {
    b = bytes[i];
    switch (groupPos) {
      case 0:
        base64 += table[b >> 2];
        p = (b & 3) << 4;
        groupPos = 1;
        break;
      case 1:
        base64 += table[p | b >> 4];
        p = (b & 15) << 2;
        groupPos = 2;
        break;
      case 2:
        base64 += table[p | b >> 6];
        base64 += table[b & 63];
        groupPos = 0;
        break;
    }
  }
  if (groupPos) {
    base64 += table[p];
    if (pad) {
      base64 += "=";
      if (groupPos == 1)
        base64 += "=";
    }
  }
  return base64;
}
var encodeTableStd;
var encodeTableUrl;
var decodeTable;
function getEncodeTable(encoding) {
  if (!encodeTableStd) {
    encodeTableStd = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
    encodeTableUrl = encodeTableStd.slice(0, -2).concat("-", "_");
  }
  return encoding == "url" ? encodeTableUrl : encodeTableStd;
}
function getDecodeTable() {
  if (!decodeTable) {
    decodeTable = [];
    const encodeTable = getEncodeTable("std");
    for (let i = 0;i < encodeTable.length; i++)
      decodeTable[encodeTable[i].charCodeAt(0)] = i;
    decodeTable[45] = encodeTable.indexOf("+");
    decodeTable[95] = encodeTable.indexOf("/");
  }
  return decodeTable;
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/names.js
function protoCamelCase(snakeCase) {
  let capNext = false;
  const b = [];
  for (let i = 0;i < snakeCase.length; i++) {
    let c = snakeCase.charAt(i);
    switch (c) {
      case "_":
        capNext = true;
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        b.push(c);
        capNext = false;
        break;
      default:
        if (capNext) {
          capNext = false;
          c = c.toUpperCase();
        }
        b.push(c);
        break;
    }
  }
  return b.join("");
}
function protoSnakeCase(lowerCamelCase) {
  return lowerCamelCase.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
}
var reservedObjectProperties = new Set([
  "constructor",
  "toString",
  "toJSON",
  "valueOf"
]);
function safeObjectProperty(name) {
  return reservedObjectProperties.has(name) ? name + "$" : name;
}

// node_modules/@bufbuild/protobuf/dist/esm/codegenv2/restore-json-names.js
function restoreJsonNames(message) {
  for (const f of message.field) {
    if (!unsafeIsSetExplicit(f, "jsonName")) {
      f.jsonName = protoCamelCase(f.name);
    }
  }
  message.nestedType.forEach(restoreJsonNames);
}

// node_modules/@bufbuild/protobuf/dist/esm/wire/text-format.js
function parseTextFormatEnumValue(descEnum, value) {
  const enumValue = descEnum.values.find((v) => v.name === value);
  if (!enumValue) {
    throw new Error(`cannot parse ${descEnum} default value: ${value}`);
  }
  return enumValue.number;
}
function parseTextFormatScalarValue(type, value) {
  switch (type) {
    case ScalarType.STRING:
      return value;
    case ScalarType.BYTES: {
      const u = unescapeBytesDefaultValue(value);
      if (u === false) {
        throw new Error(`cannot parse ${ScalarType[type]} default value: ${value}`);
      }
      return u;
    }
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      return protoInt64.parse(value);
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return protoInt64.uParse(value);
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      switch (value) {
        case "inf":
          return Number.POSITIVE_INFINITY;
        case "-inf":
          return Number.NEGATIVE_INFINITY;
        case "nan":
          return Number.NaN;
        default:
          return parseFloat(value);
      }
    case ScalarType.BOOL:
      return value === "true";
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return parseInt(value, 10);
  }
}
function unescapeBytesDefaultValue(str) {
  const b = [];
  const input = {
    tail: str,
    c: "",
    next() {
      if (this.tail.length == 0) {
        return false;
      }
      this.c = this.tail[0];
      this.tail = this.tail.substring(1);
      return true;
    },
    take(n) {
      if (this.tail.length >= n) {
        const r = this.tail.substring(0, n);
        this.tail = this.tail.substring(n);
        return r;
      }
      return false;
    }
  };
  while (input.next()) {
    switch (input.c) {
      case "\\":
        if (input.next()) {
          switch (input.c) {
            case "\\":
              b.push(input.c.charCodeAt(0));
              break;
            case "b":
              b.push(8);
              break;
            case "f":
              b.push(12);
              break;
            case "n":
              b.push(10);
              break;
            case "r":
              b.push(13);
              break;
            case "t":
              b.push(9);
              break;
            case "v":
              b.push(11);
              break;
            case "0":
            case "1":
            case "2":
            case "3":
            case "4":
            case "5":
            case "6":
            case "7": {
              const s = input.c;
              const t = input.take(2);
              if (t === false) {
                return false;
              }
              const n = parseInt(s + t, 8);
              if (Number.isNaN(n)) {
                return false;
              }
              b.push(n);
              break;
            }
            case "x": {
              const s = input.c;
              const t = input.take(2);
              if (t === false) {
                return false;
              }
              const n = parseInt(s + t, 16);
              if (Number.isNaN(n)) {
                return false;
              }
              b.push(n);
              break;
            }
            case "u": {
              const s = input.c;
              const t = input.take(4);
              if (t === false) {
                return false;
              }
              const n = parseInt(s + t, 16);
              if (Number.isNaN(n)) {
                return false;
              }
              const chunk = new Uint8Array(4);
              const view = new DataView(chunk.buffer);
              view.setInt32(0, n, true);
              b.push(chunk[0], chunk[1], chunk[2], chunk[3]);
              break;
            }
            case "U": {
              const s = input.c;
              const t = input.take(8);
              if (t === false) {
                return false;
              }
              const tc = protoInt64.uEnc(s + t);
              const chunk = new Uint8Array(8);
              const view = new DataView(chunk.buffer);
              view.setInt32(0, tc.lo, true);
              view.setInt32(4, tc.hi, true);
              b.push(chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7]);
              break;
            }
          }
        }
        break;
      default:
        b.push(input.c.charCodeAt(0));
    }
  }
  return new Uint8Array(b);
}

// node_modules/@bufbuild/protobuf/dist/esm/reflect/nested-types.js
function* nestedTypes(desc) {
  switch (desc.kind) {
    case "file":
      for (const message of desc.messages) {
        yield message;
        yield* nestedTypes(message);
      }
      yield* desc.enums;
      yield* desc.services;
      yield* desc.extensions;
      break;
    case "message":
      for (const message of desc.nestedMessages) {
        yield message;
        yield* nestedTypes(message);
      }
      yield* desc.nestedEnums;
      yield* desc.nestedExtensions;
      break;
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/registry.js
function createFileRegistry(...args) {
  const registry = createBaseRegistry();
  if (!args.length) {
    return registry;
  }
  if ("$typeName" in args[0] && args[0].$typeName == "google.protobuf.FileDescriptorSet") {
    for (const file of args[0].file) {
      addFile(file, registry);
    }
    return registry;
  }
  if ("$typeName" in args[0]) {
    let recurseDeps = function(file) {
      const deps = [];
      for (const protoFileName of file.dependency) {
        if (registry.getFile(protoFileName) != null) {
          continue;
        }
        if (seen.has(protoFileName)) {
          continue;
        }
        const dep = resolve(protoFileName);
        if (!dep) {
          throw new Error(`Unable to resolve ${protoFileName}, imported by ${file.name}`);
        }
        if ("kind" in dep) {
          registry.addFile(dep, false, true);
        } else {
          seen.add(dep.name);
          deps.push(dep);
        }
      }
      return deps.concat(...deps.map(recurseDeps));
    };
    const input = args[0];
    const resolve = args[1];
    const seen = new Set;
    for (const file of [input, ...recurseDeps(input)].reverse()) {
      addFile(file, registry);
    }
  } else {
    for (const fileReg of args) {
      for (const file of fileReg.files) {
        registry.addFile(file);
      }
    }
  }
  return registry;
}
function createBaseRegistry() {
  const types = new Map;
  const extendees = new Map;
  const files = new Map;
  return {
    kind: "registry",
    types,
    extendees,
    [Symbol.iterator]() {
      return types.values();
    },
    get files() {
      return files.values();
    },
    addFile(file, skipTypes, withDeps) {
      files.set(file.proto.name, file);
      if (!skipTypes) {
        for (const type of nestedTypes(file)) {
          this.add(type);
        }
      }
      if (withDeps) {
        for (const f of file.dependencies) {
          this.addFile(f, skipTypes, withDeps);
        }
      }
    },
    add(desc) {
      if (desc.kind == "extension") {
        let numberToExt = extendees.get(desc.extendee.typeName);
        if (!numberToExt) {
          extendees.set(desc.extendee.typeName, numberToExt = new Map);
        }
        numberToExt.set(desc.number, desc);
      }
      types.set(desc.typeName, desc);
    },
    get(typeName) {
      return types.get(typeName);
    },
    getFile(fileName) {
      return files.get(fileName);
    },
    getMessage(typeName) {
      const t = types.get(typeName);
      return (t === null || t === undefined ? undefined : t.kind) == "message" ? t : undefined;
    },
    getEnum(typeName) {
      const t = types.get(typeName);
      return (t === null || t === undefined ? undefined : t.kind) == "enum" ? t : undefined;
    },
    getExtension(typeName) {
      const t = types.get(typeName);
      return (t === null || t === undefined ? undefined : t.kind) == "extension" ? t : undefined;
    },
    getExtensionFor(extendee, no) {
      var _a;
      return (_a = extendees.get(extendee.typeName)) === null || _a === undefined ? undefined : _a.get(no);
    },
    getService(typeName) {
      const t = types.get(typeName);
      return (t === null || t === undefined ? undefined : t.kind) == "service" ? t : undefined;
    }
  };
}
var EDITION_PROTO22 = 998;
var EDITION_PROTO32 = 999;
var TYPE_STRING = 9;
var TYPE_GROUP = 10;
var TYPE_MESSAGE = 11;
var TYPE_BYTES = 12;
var TYPE_ENUM = 14;
var LABEL_REPEATED = 3;
var LABEL_REQUIRED = 2;
var JS_STRING = 1;
var IDEMPOTENCY_UNKNOWN = 0;
var EXPLICIT = 1;
var IMPLICIT3 = 2;
var LEGACY_REQUIRED = 3;
var PACKED = 1;
var DELIMITED = 2;
var OPEN = 1;
var featureDefaults = {
  998: {
    fieldPresence: 1,
    enumType: 2,
    repeatedFieldEncoding: 2,
    utf8Validation: 3,
    messageEncoding: 1,
    jsonFormat: 2,
    enforceNamingStyle: 2,
    defaultSymbolVisibility: 1
  },
  999: {
    fieldPresence: 2,
    enumType: 1,
    repeatedFieldEncoding: 1,
    utf8Validation: 2,
    messageEncoding: 1,
    jsonFormat: 1,
    enforceNamingStyle: 2,
    defaultSymbolVisibility: 1
  },
  1000: {
    fieldPresence: 1,
    enumType: 1,
    repeatedFieldEncoding: 1,
    utf8Validation: 2,
    messageEncoding: 1,
    jsonFormat: 1,
    enforceNamingStyle: 2,
    defaultSymbolVisibility: 1
  },
  1001: {
    fieldPresence: 1,
    enumType: 1,
    repeatedFieldEncoding: 1,
    utf8Validation: 2,
    messageEncoding: 1,
    jsonFormat: 1,
    enforceNamingStyle: 1,
    defaultSymbolVisibility: 2
  }
};
function addFile(proto, reg) {
  var _a, _b;
  const file = {
    kind: "file",
    proto,
    deprecated: (_b = (_a = proto.options) === null || _a === undefined ? undefined : _a.deprecated) !== null && _b !== undefined ? _b : false,
    edition: getFileEdition(proto),
    name: proto.name.replace(/\.proto$/, ""),
    dependencies: findFileDependencies(proto, reg),
    enums: [],
    messages: [],
    extensions: [],
    services: [],
    toString() {
      return `file ${proto.name}`;
    }
  };
  const mapEntriesStore = new Map;
  const mapEntries = {
    get(typeName) {
      return mapEntriesStore.get(typeName);
    },
    add(desc) {
      var _a2;
      assert(((_a2 = desc.proto.options) === null || _a2 === undefined ? undefined : _a2.mapEntry) === true);
      mapEntriesStore.set(desc.typeName, desc);
    }
  };
  for (const enumProto of proto.enumType) {
    addEnum(enumProto, file, undefined, reg);
  }
  for (const messageProto of proto.messageType) {
    addMessage(messageProto, file, undefined, reg, mapEntries);
  }
  for (const serviceProto of proto.service) {
    addService(serviceProto, file, reg);
  }
  addExtensions(file, reg);
  for (const mapEntry of mapEntriesStore.values()) {
    addFields(mapEntry, reg, mapEntries);
  }
  for (const message of file.messages) {
    addFields(message, reg, mapEntries);
    addExtensions(message, reg);
  }
  reg.addFile(file, true);
}
function addExtensions(desc, reg) {
  switch (desc.kind) {
    case "file":
      for (const proto of desc.proto.extension) {
        const ext = newField(proto, desc, reg);
        desc.extensions.push(ext);
        reg.add(ext);
      }
      break;
    case "message":
      for (const proto of desc.proto.extension) {
        const ext = newField(proto, desc, reg);
        desc.nestedExtensions.push(ext);
        reg.add(ext);
      }
      for (const message of desc.nestedMessages) {
        addExtensions(message, reg);
      }
      break;
  }
}
function addFields(message, reg, mapEntries) {
  const allOneofs = message.proto.oneofDecl.map((proto) => newOneof(proto, message));
  const oneofsSeen = new Set;
  for (const proto of message.proto.field) {
    const oneof = findOneof(proto, allOneofs);
    const field = newField(proto, message, reg, oneof, mapEntries);
    message.fields.push(field);
    message.field[field.localName] = field;
    if (oneof === undefined) {
      message.members.push(field);
    } else {
      oneof.fields.push(field);
      if (!oneofsSeen.has(oneof)) {
        oneofsSeen.add(oneof);
        message.members.push(oneof);
      }
    }
  }
  for (const oneof of allOneofs.filter((o) => oneofsSeen.has(o))) {
    message.oneofs.push(oneof);
  }
  for (const child of message.nestedMessages) {
    addFields(child, reg, mapEntries);
  }
}
function addEnum(proto, file, parent, reg) {
  var _a, _b, _c, _d, _e;
  const sharedPrefix = findEnumSharedPrefix(proto.name, proto.value);
  const desc = {
    kind: "enum",
    proto,
    deprecated: (_b = (_a = proto.options) === null || _a === undefined ? undefined : _a.deprecated) !== null && _b !== undefined ? _b : false,
    file,
    parent,
    open: true,
    name: proto.name,
    typeName: makeTypeName(proto, parent, file),
    value: {},
    values: [],
    sharedPrefix,
    toString() {
      return `enum ${this.typeName}`;
    }
  };
  desc.open = isEnumOpen(desc);
  reg.add(desc);
  for (const p of proto.value) {
    const name = p.name;
    desc.values.push(desc.value[p.number] = {
      kind: "enum_value",
      proto: p,
      deprecated: (_d = (_c = p.options) === null || _c === undefined ? undefined : _c.deprecated) !== null && _d !== undefined ? _d : false,
      parent: desc,
      name,
      localName: safeObjectProperty(sharedPrefix == undefined ? name : name.substring(sharedPrefix.length)),
      number: p.number,
      toString() {
        return `enum value ${desc.typeName}.${name}`;
      }
    });
  }
  ((_e = parent === null || parent === undefined ? undefined : parent.nestedEnums) !== null && _e !== undefined ? _e : file.enums).push(desc);
}
function addMessage(proto, file, parent, reg, mapEntries) {
  var _a, _b, _c, _d;
  const desc = {
    kind: "message",
    proto,
    deprecated: (_b = (_a = proto.options) === null || _a === undefined ? undefined : _a.deprecated) !== null && _b !== undefined ? _b : false,
    file,
    parent,
    name: proto.name,
    typeName: makeTypeName(proto, parent, file),
    fields: [],
    field: {},
    oneofs: [],
    members: [],
    nestedEnums: [],
    nestedMessages: [],
    nestedExtensions: [],
    toString() {
      return `message ${this.typeName}`;
    }
  };
  if (((_c = proto.options) === null || _c === undefined ? undefined : _c.mapEntry) === true) {
    mapEntries.add(desc);
  } else {
    ((_d = parent === null || parent === undefined ? undefined : parent.nestedMessages) !== null && _d !== undefined ? _d : file.messages).push(desc);
    reg.add(desc);
  }
  for (const enumProto of proto.enumType) {
    addEnum(enumProto, file, desc, reg);
  }
  for (const messageProto of proto.nestedType) {
    addMessage(messageProto, file, desc, reg, mapEntries);
  }
}
function addService(proto, file, reg) {
  var _a, _b;
  const desc = {
    kind: "service",
    proto,
    deprecated: (_b = (_a = proto.options) === null || _a === undefined ? undefined : _a.deprecated) !== null && _b !== undefined ? _b : false,
    file,
    name: proto.name,
    typeName: makeTypeName(proto, undefined, file),
    methods: [],
    method: {},
    toString() {
      return `service ${this.typeName}`;
    }
  };
  file.services.push(desc);
  reg.add(desc);
  for (const methodProto of proto.method) {
    const method = newMethod(methodProto, desc, reg);
    desc.methods.push(method);
    desc.method[method.localName] = method;
  }
}
function newMethod(proto, parent, reg) {
  var _a, _b, _c, _d;
  let methodKind;
  if (proto.clientStreaming && proto.serverStreaming) {
    methodKind = "bidi_streaming";
  } else if (proto.clientStreaming) {
    methodKind = "client_streaming";
  } else if (proto.serverStreaming) {
    methodKind = "server_streaming";
  } else {
    methodKind = "unary";
  }
  const input = reg.getMessage(trimLeadingDot(proto.inputType));
  const output = reg.getMessage(trimLeadingDot(proto.outputType));
  assert(input, `invalid MethodDescriptorProto: input_type ${proto.inputType} not found`);
  assert(output, `invalid MethodDescriptorProto: output_type ${proto.inputType} not found`);
  const name = proto.name;
  return {
    kind: "rpc",
    proto,
    deprecated: (_b = (_a = proto.options) === null || _a === undefined ? undefined : _a.deprecated) !== null && _b !== undefined ? _b : false,
    parent,
    name,
    localName: safeObjectProperty(name.length ? safeObjectProperty(name[0].toLowerCase() + name.substring(1)) : name),
    methodKind,
    input,
    output,
    idempotency: (_d = (_c = proto.options) === null || _c === undefined ? undefined : _c.idempotencyLevel) !== null && _d !== undefined ? _d : IDEMPOTENCY_UNKNOWN,
    toString() {
      return `rpc ${parent.typeName}.${name}`;
    }
  };
}
function newOneof(proto, parent) {
  return {
    kind: "oneof",
    proto,
    deprecated: false,
    parent,
    fields: [],
    name: proto.name,
    localName: safeObjectProperty(protoCamelCase(proto.name)),
    toString() {
      return `oneof ${parent.typeName}.${this.name}`;
    }
  };
}
function newField(proto, parentOrFile, reg, oneof, mapEntries) {
  var _a, _b, _c;
  const isExtension = mapEntries === undefined;
  const field = {
    kind: "field",
    proto,
    deprecated: (_b = (_a = proto.options) === null || _a === undefined ? undefined : _a.deprecated) !== null && _b !== undefined ? _b : false,
    name: proto.name,
    number: proto.number,
    scalar: undefined,
    message: undefined,
    enum: undefined,
    presence: getFieldPresence(proto, oneof, isExtension, parentOrFile),
    listKind: undefined,
    mapKind: undefined,
    mapKey: undefined,
    delimitedEncoding: undefined,
    packed: undefined,
    longAsString: false,
    getDefaultValue: undefined
  };
  if (isExtension) {
    const file = parentOrFile.kind == "file" ? parentOrFile : parentOrFile.file;
    const parent = parentOrFile.kind == "file" ? undefined : parentOrFile;
    const typeName = makeTypeName(proto, parent, file);
    field.kind = "extension";
    field.file = file;
    field.parent = parent;
    field.oneof = undefined;
    field.typeName = typeName;
    field.jsonName = `[${typeName}]`;
    field.toString = () => `extension ${typeName}`;
    const extendee = reg.getMessage(trimLeadingDot(proto.extendee));
    assert(extendee, `invalid FieldDescriptorProto: extendee ${proto.extendee} not found`);
    field.extendee = extendee;
  } else {
    const parent = parentOrFile;
    assert(parent.kind == "message");
    field.parent = parent;
    field.oneof = oneof;
    field.localName = oneof ? protoCamelCase(proto.name) : safeObjectProperty(protoCamelCase(proto.name));
    field.jsonName = proto.jsonName;
    field.toString = () => `field ${parent.typeName}.${proto.name}`;
  }
  const label = proto.label;
  const type = proto.type;
  const jstype = (_c = proto.options) === null || _c === undefined ? undefined : _c.jstype;
  if (label === LABEL_REPEATED) {
    const mapEntry = type == TYPE_MESSAGE ? mapEntries === null || mapEntries === undefined ? undefined : mapEntries.get(trimLeadingDot(proto.typeName)) : undefined;
    if (mapEntry) {
      field.fieldKind = "map";
      const { key, value } = findMapEntryFields(mapEntry);
      field.mapKey = key.scalar;
      field.mapKind = value.fieldKind;
      field.message = value.message;
      field.delimitedEncoding = false;
      field.enum = value.enum;
      field.scalar = value.scalar;
      return field;
    }
    field.fieldKind = "list";
    switch (type) {
      case TYPE_MESSAGE:
      case TYPE_GROUP:
        field.listKind = "message";
        field.message = reg.getMessage(trimLeadingDot(proto.typeName));
        assert(field.message);
        field.delimitedEncoding = isDelimitedEncoding(proto, parentOrFile);
        break;
      case TYPE_ENUM:
        field.listKind = "enum";
        field.enum = reg.getEnum(trimLeadingDot(proto.typeName));
        assert(field.enum);
        break;
      default:
        field.listKind = "scalar";
        field.scalar = type;
        field.longAsString = jstype == JS_STRING;
        break;
    }
    field.packed = isPackedField(proto, parentOrFile);
    return field;
  }
  switch (type) {
    case TYPE_MESSAGE:
    case TYPE_GROUP:
      field.fieldKind = "message";
      field.message = reg.getMessage(trimLeadingDot(proto.typeName));
      assert(field.message, `invalid FieldDescriptorProto: type_name ${proto.typeName} not found`);
      field.delimitedEncoding = isDelimitedEncoding(proto, parentOrFile);
      field.getDefaultValue = () => {
        return;
      };
      break;
    case TYPE_ENUM: {
      const enumeration = reg.getEnum(trimLeadingDot(proto.typeName));
      assert(enumeration !== undefined, `invalid FieldDescriptorProto: type_name ${proto.typeName} not found`);
      field.fieldKind = "enum";
      field.enum = reg.getEnum(trimLeadingDot(proto.typeName));
      field.getDefaultValue = () => {
        return unsafeIsSetExplicit(proto, "defaultValue") ? parseTextFormatEnumValue(enumeration, proto.defaultValue) : undefined;
      };
      break;
    }
    default: {
      field.fieldKind = "scalar";
      field.scalar = type;
      field.longAsString = jstype == JS_STRING;
      field.getDefaultValue = () => {
        return unsafeIsSetExplicit(proto, "defaultValue") ? parseTextFormatScalarValue(type, proto.defaultValue) : undefined;
      };
      break;
    }
  }
  return field;
}
function getFileEdition(proto) {
  switch (proto.syntax) {
    case "":
    case "proto2":
      return EDITION_PROTO22;
    case "proto3":
      return EDITION_PROTO32;
    case "editions":
      if (proto.edition in featureDefaults) {
        return proto.edition;
      }
      throw new Error(`${proto.name}: unsupported edition`);
    default:
      throw new Error(`${proto.name}: unsupported syntax "${proto.syntax}"`);
  }
}
function findFileDependencies(proto, reg) {
  return proto.dependency.map((wantName) => {
    const dep = reg.getFile(wantName);
    if (!dep) {
      throw new Error(`Cannot find ${wantName}, imported by ${proto.name}`);
    }
    return dep;
  });
}
function findEnumSharedPrefix(enumName, values) {
  const prefix = camelToSnakeCase(enumName) + "_";
  for (const value of values) {
    if (!value.name.toLowerCase().startsWith(prefix)) {
      return;
    }
    const shortName = value.name.substring(prefix.length);
    if (shortName.length == 0) {
      return;
    }
    if (/^\d/.test(shortName)) {
      return;
    }
  }
  return prefix;
}
function camelToSnakeCase(camel) {
  return (camel.substring(0, 1) + camel.substring(1).replace(/[A-Z]/g, (c) => "_" + c)).toLowerCase();
}
function makeTypeName(proto, parent, file) {
  let typeName;
  if (parent) {
    typeName = `${parent.typeName}.${proto.name}`;
  } else if (file.proto.package.length > 0) {
    typeName = `${file.proto.package}.${proto.name}`;
  } else {
    typeName = `${proto.name}`;
  }
  return typeName;
}
function trimLeadingDot(typeName) {
  return typeName.startsWith(".") ? typeName.substring(1) : typeName;
}
function findOneof(proto, allOneofs) {
  if (!unsafeIsSetExplicit(proto, "oneofIndex")) {
    return;
  }
  if (proto.proto3Optional) {
    return;
  }
  const oneof = allOneofs[proto.oneofIndex];
  assert(oneof, `invalid FieldDescriptorProto: oneof #${proto.oneofIndex} for field #${proto.number} not found`);
  return oneof;
}
function getFieldPresence(proto, oneof, isExtension, parent) {
  if (proto.label == LABEL_REQUIRED) {
    return LEGACY_REQUIRED;
  }
  if (proto.label == LABEL_REPEATED) {
    return IMPLICIT3;
  }
  if (!!oneof || proto.proto3Optional) {
    return EXPLICIT;
  }
  if (isExtension) {
    return EXPLICIT;
  }
  const resolved = resolveFeature("fieldPresence", { proto, parent });
  if (resolved == IMPLICIT3 && (proto.type == TYPE_MESSAGE || proto.type == TYPE_GROUP)) {
    return EXPLICIT;
  }
  return resolved;
}
function isPackedField(proto, parent) {
  if (proto.label != LABEL_REPEATED) {
    return false;
  }
  switch (proto.type) {
    case TYPE_STRING:
    case TYPE_BYTES:
    case TYPE_GROUP:
    case TYPE_MESSAGE:
      return false;
  }
  const o = proto.options;
  if (o && unsafeIsSetExplicit(o, "packed")) {
    return o.packed;
  }
  return PACKED == resolveFeature("repeatedFieldEncoding", {
    proto,
    parent
  });
}
function findMapEntryFields(mapEntry) {
  const key = mapEntry.fields.find((f) => f.number === 1);
  const value = mapEntry.fields.find((f) => f.number === 2);
  assert(key && key.fieldKind == "scalar" && key.scalar != ScalarType.BYTES && key.scalar != ScalarType.FLOAT && key.scalar != ScalarType.DOUBLE && value && value.fieldKind != "list" && value.fieldKind != "map");
  return { key, value };
}
function isEnumOpen(desc) {
  var _a;
  return OPEN == resolveFeature("enumType", {
    proto: desc.proto,
    parent: (_a = desc.parent) !== null && _a !== undefined ? _a : desc.file
  });
}
function isDelimitedEncoding(proto, parent) {
  if (proto.type == TYPE_GROUP) {
    return true;
  }
  return DELIMITED == resolveFeature("messageEncoding", {
    proto,
    parent
  });
}
function resolveFeature(name, ref) {
  var _a, _b;
  const featureSet = (_a = ref.proto.options) === null || _a === undefined ? undefined : _a.features;
  if (featureSet) {
    const val = featureSet[name];
    if (val != 0) {
      return val;
    }
  }
  if ("kind" in ref) {
    if (ref.kind == "message") {
      return resolveFeature(name, (_b = ref.parent) !== null && _b !== undefined ? _b : ref.file);
    }
    const editionDefaults = featureDefaults[ref.edition];
    if (!editionDefaults) {
      throw new Error(`feature default for edition ${ref.edition} not found`);
    }
    return editionDefaults[name];
  }
  return resolveFeature(name, ref.parent);
}
function assert(condition, msg) {
  if (!condition) {
    throw new Error(msg);
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/codegenv2/boot.js
function boot(boot2) {
  const root = bootFileDescriptorProto(boot2);
  root.messageType.forEach(restoreJsonNames);
  const reg = createFileRegistry(root, () => {
    return;
  });
  return reg.getFile(root.name);
}
function bootFileDescriptorProto(init) {
  const proto = Object.create({
    syntax: "",
    edition: 0
  });
  return Object.assign(proto, Object.assign(Object.assign({ $typeName: "google.protobuf.FileDescriptorProto", dependency: [], publicDependency: [], weakDependency: [], optionDependency: [], service: [], extension: [] }, init), { messageType: init.messageType.map(bootDescriptorProto), enumType: init.enumType.map(bootEnumDescriptorProto) }));
}
function bootDescriptorProto(init) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  const proto = Object.create({
    visibility: 0
  });
  return Object.assign(proto, {
    $typeName: "google.protobuf.DescriptorProto",
    name: init.name,
    field: (_b = (_a = init.field) === null || _a === undefined ? undefined : _a.map(bootFieldDescriptorProto)) !== null && _b !== undefined ? _b : [],
    extension: [],
    nestedType: (_d = (_c = init.nestedType) === null || _c === undefined ? undefined : _c.map(bootDescriptorProto)) !== null && _d !== undefined ? _d : [],
    enumType: (_f = (_e = init.enumType) === null || _e === undefined ? undefined : _e.map(bootEnumDescriptorProto)) !== null && _f !== undefined ? _f : [],
    extensionRange: (_h = (_g = init.extensionRange) === null || _g === undefined ? undefined : _g.map((e) => Object.assign({ $typeName: "google.protobuf.DescriptorProto.ExtensionRange" }, e))) !== null && _h !== undefined ? _h : [],
    oneofDecl: [],
    reservedRange: [],
    reservedName: []
  });
}
function bootFieldDescriptorProto(init) {
  const proto = Object.create({
    label: 1,
    typeName: "",
    extendee: "",
    defaultValue: "",
    oneofIndex: 0,
    jsonName: "",
    proto3Optional: false
  });
  return Object.assign(proto, Object.assign(Object.assign({ $typeName: "google.protobuf.FieldDescriptorProto" }, init), { options: init.options ? bootFieldOptions(init.options) : undefined }));
}
function bootFieldOptions(init) {
  var _a, _b, _c;
  const proto = Object.create({
    ctype: 0,
    packed: false,
    jstype: 0,
    lazy: false,
    unverifiedLazy: false,
    deprecated: false,
    weak: false,
    debugRedact: false,
    retention: 0
  });
  return Object.assign(proto, Object.assign(Object.assign({ $typeName: "google.protobuf.FieldOptions" }, init), { targets: (_a = init.targets) !== null && _a !== undefined ? _a : [], editionDefaults: (_c = (_b = init.editionDefaults) === null || _b === undefined ? undefined : _b.map((e) => Object.assign({ $typeName: "google.protobuf.FieldOptions.EditionDefault" }, e))) !== null && _c !== undefined ? _c : [], uninterpretedOption: [] }));
}
function bootEnumDescriptorProto(init) {
  const proto = Object.create({
    visibility: 0
  });
  return Object.assign(proto, {
    $typeName: "google.protobuf.EnumDescriptorProto",
    name: init.name,
    reservedName: [],
    reservedRange: [],
    value: init.value.map((e) => Object.assign({ $typeName: "google.protobuf.EnumValueDescriptorProto" }, e))
  });
}

// node_modules/@bufbuild/protobuf/dist/esm/codegenv2/message.js
function messageDesc(file, path, ...paths) {
  return paths.reduce((acc, cur) => acc.nestedMessages[cur], file.messages[path]);
}

// node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/descriptor_pb.js
var file_google_protobuf_descriptor = /* @__PURE__ */ boot({ name: "google/protobuf/descriptor.proto", package: "google.protobuf", messageType: [{ name: "FileDescriptorSet", field: [{ name: "file", number: 1, type: 11, label: 3, typeName: ".google.protobuf.FileDescriptorProto" }], extensionRange: [{ start: 536000000, end: 536000001 }] }, { name: "FileDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "package", number: 2, type: 9, label: 1 }, { name: "dependency", number: 3, type: 9, label: 3 }, { name: "public_dependency", number: 10, type: 5, label: 3 }, { name: "weak_dependency", number: 11, type: 5, label: 3 }, { name: "option_dependency", number: 15, type: 9, label: 3 }, { name: "message_type", number: 4, type: 11, label: 3, typeName: ".google.protobuf.DescriptorProto" }, { name: "enum_type", number: 5, type: 11, label: 3, typeName: ".google.protobuf.EnumDescriptorProto" }, { name: "service", number: 6, type: 11, label: 3, typeName: ".google.protobuf.ServiceDescriptorProto" }, { name: "extension", number: 7, type: 11, label: 3, typeName: ".google.protobuf.FieldDescriptorProto" }, { name: "options", number: 8, type: 11, label: 1, typeName: ".google.protobuf.FileOptions" }, { name: "source_code_info", number: 9, type: 11, label: 1, typeName: ".google.protobuf.SourceCodeInfo" }, { name: "syntax", number: 12, type: 9, label: 1 }, { name: "edition", number: 14, type: 14, label: 1, typeName: ".google.protobuf.Edition" }] }, { name: "DescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "field", number: 2, type: 11, label: 3, typeName: ".google.protobuf.FieldDescriptorProto" }, { name: "extension", number: 6, type: 11, label: 3, typeName: ".google.protobuf.FieldDescriptorProto" }, { name: "nested_type", number: 3, type: 11, label: 3, typeName: ".google.protobuf.DescriptorProto" }, { name: "enum_type", number: 4, type: 11, label: 3, typeName: ".google.protobuf.EnumDescriptorProto" }, { name: "extension_range", number: 5, type: 11, label: 3, typeName: ".google.protobuf.DescriptorProto.ExtensionRange" }, { name: "oneof_decl", number: 8, type: 11, label: 3, typeName: ".google.protobuf.OneofDescriptorProto" }, { name: "options", number: 7, type: 11, label: 1, typeName: ".google.protobuf.MessageOptions" }, { name: "reserved_range", number: 9, type: 11, label: 3, typeName: ".google.protobuf.DescriptorProto.ReservedRange" }, { name: "reserved_name", number: 10, type: 9, label: 3 }, { name: "visibility", number: 11, type: 14, label: 1, typeName: ".google.protobuf.SymbolVisibility" }], nestedType: [{ name: "ExtensionRange", field: [{ name: "start", number: 1, type: 5, label: 1 }, { name: "end", number: 2, type: 5, label: 1 }, { name: "options", number: 3, type: 11, label: 1, typeName: ".google.protobuf.ExtensionRangeOptions" }] }, { name: "ReservedRange", field: [{ name: "start", number: 1, type: 5, label: 1 }, { name: "end", number: 2, type: 5, label: 1 }] }] }, { name: "ExtensionRangeOptions", field: [{ name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }, { name: "declaration", number: 2, type: 11, label: 3, typeName: ".google.protobuf.ExtensionRangeOptions.Declaration", options: { retention: 2 } }, { name: "features", number: 50, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "verification", number: 3, type: 14, label: 1, typeName: ".google.protobuf.ExtensionRangeOptions.VerificationState", defaultValue: "UNVERIFIED", options: { retention: 2 } }], nestedType: [{ name: "Declaration", field: [{ name: "number", number: 1, type: 5, label: 1 }, { name: "full_name", number: 2, type: 9, label: 1 }, { name: "type", number: 3, type: 9, label: 1 }, { name: "reserved", number: 5, type: 8, label: 1 }, { name: "repeated", number: 6, type: 8, label: 1 }] }], enumType: [{ name: "VerificationState", value: [{ name: "DECLARATION", number: 0 }, { name: "UNVERIFIED", number: 1 }] }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "FieldDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "number", number: 3, type: 5, label: 1 }, { name: "label", number: 4, type: 14, label: 1, typeName: ".google.protobuf.FieldDescriptorProto.Label" }, { name: "type", number: 5, type: 14, label: 1, typeName: ".google.protobuf.FieldDescriptorProto.Type" }, { name: "type_name", number: 6, type: 9, label: 1 }, { name: "extendee", number: 2, type: 9, label: 1 }, { name: "default_value", number: 7, type: 9, label: 1 }, { name: "oneof_index", number: 9, type: 5, label: 1 }, { name: "json_name", number: 10, type: 9, label: 1 }, { name: "options", number: 8, type: 11, label: 1, typeName: ".google.protobuf.FieldOptions" }, { name: "proto3_optional", number: 17, type: 8, label: 1 }], enumType: [{ name: "Type", value: [{ name: "TYPE_DOUBLE", number: 1 }, { name: "TYPE_FLOAT", number: 2 }, { name: "TYPE_INT64", number: 3 }, { name: "TYPE_UINT64", number: 4 }, { name: "TYPE_INT32", number: 5 }, { name: "TYPE_FIXED64", number: 6 }, { name: "TYPE_FIXED32", number: 7 }, { name: "TYPE_BOOL", number: 8 }, { name: "TYPE_STRING", number: 9 }, { name: "TYPE_GROUP", number: 10 }, { name: "TYPE_MESSAGE", number: 11 }, { name: "TYPE_BYTES", number: 12 }, { name: "TYPE_UINT32", number: 13 }, { name: "TYPE_ENUM", number: 14 }, { name: "TYPE_SFIXED32", number: 15 }, { name: "TYPE_SFIXED64", number: 16 }, { name: "TYPE_SINT32", number: 17 }, { name: "TYPE_SINT64", number: 18 }] }, { name: "Label", value: [{ name: "LABEL_OPTIONAL", number: 1 }, { name: "LABEL_REPEATED", number: 3 }, { name: "LABEL_REQUIRED", number: 2 }] }] }, { name: "OneofDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "options", number: 2, type: 11, label: 1, typeName: ".google.protobuf.OneofOptions" }] }, { name: "EnumDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "value", number: 2, type: 11, label: 3, typeName: ".google.protobuf.EnumValueDescriptorProto" }, { name: "options", number: 3, type: 11, label: 1, typeName: ".google.protobuf.EnumOptions" }, { name: "reserved_range", number: 4, type: 11, label: 3, typeName: ".google.protobuf.EnumDescriptorProto.EnumReservedRange" }, { name: "reserved_name", number: 5, type: 9, label: 3 }, { name: "visibility", number: 6, type: 14, label: 1, typeName: ".google.protobuf.SymbolVisibility" }], nestedType: [{ name: "EnumReservedRange", field: [{ name: "start", number: 1, type: 5, label: 1 }, { name: "end", number: 2, type: 5, label: 1 }] }] }, { name: "EnumValueDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "number", number: 2, type: 5, label: 1 }, { name: "options", number: 3, type: 11, label: 1, typeName: ".google.protobuf.EnumValueOptions" }] }, { name: "ServiceDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "method", number: 2, type: 11, label: 3, typeName: ".google.protobuf.MethodDescriptorProto" }, { name: "options", number: 3, type: 11, label: 1, typeName: ".google.protobuf.ServiceOptions" }] }, { name: "MethodDescriptorProto", field: [{ name: "name", number: 1, type: 9, label: 1 }, { name: "input_type", number: 2, type: 9, label: 1 }, { name: "output_type", number: 3, type: 9, label: 1 }, { name: "options", number: 4, type: 11, label: 1, typeName: ".google.protobuf.MethodOptions" }, { name: "client_streaming", number: 5, type: 8, label: 1, defaultValue: "false" }, { name: "server_streaming", number: 6, type: 8, label: 1, defaultValue: "false" }] }, { name: "FileOptions", field: [{ name: "java_package", number: 1, type: 9, label: 1 }, { name: "java_outer_classname", number: 8, type: 9, label: 1 }, { name: "java_multiple_files", number: 10, type: 8, label: 1, defaultValue: "false" }, { name: "java_generate_equals_and_hash", number: 20, type: 8, label: 1, options: { deprecated: true } }, { name: "java_string_check_utf8", number: 27, type: 8, label: 1, defaultValue: "false" }, { name: "optimize_for", number: 9, type: 14, label: 1, typeName: ".google.protobuf.FileOptions.OptimizeMode", defaultValue: "SPEED" }, { name: "go_package", number: 11, type: 9, label: 1 }, { name: "cc_generic_services", number: 16, type: 8, label: 1, defaultValue: "false" }, { name: "java_generic_services", number: 17, type: 8, label: 1, defaultValue: "false" }, { name: "py_generic_services", number: 18, type: 8, label: 1, defaultValue: "false" }, { name: "deprecated", number: 23, type: 8, label: 1, defaultValue: "false" }, { name: "cc_enable_arenas", number: 31, type: 8, label: 1, defaultValue: "true" }, { name: "objc_class_prefix", number: 36, type: 9, label: 1 }, { name: "csharp_namespace", number: 37, type: 9, label: 1 }, { name: "swift_prefix", number: 39, type: 9, label: 1 }, { name: "php_class_prefix", number: 40, type: 9, label: 1 }, { name: "php_namespace", number: 41, type: 9, label: 1 }, { name: "php_metadata_namespace", number: 44, type: 9, label: 1 }, { name: "ruby_package", number: 45, type: 9, label: 1 }, { name: "features", number: 50, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], enumType: [{ name: "OptimizeMode", value: [{ name: "SPEED", number: 1 }, { name: "CODE_SIZE", number: 2 }, { name: "LITE_RUNTIME", number: 3 }] }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "MessageOptions", field: [{ name: "message_set_wire_format", number: 1, type: 8, label: 1, defaultValue: "false" }, { name: "no_standard_descriptor_accessor", number: 2, type: 8, label: 1, defaultValue: "false" }, { name: "deprecated", number: 3, type: 8, label: 1, defaultValue: "false" }, { name: "map_entry", number: 7, type: 8, label: 1 }, { name: "deprecated_legacy_json_field_conflicts", number: 11, type: 8, label: 1, options: { deprecated: true } }, { name: "features", number: 12, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "FieldOptions", field: [{ name: "ctype", number: 1, type: 14, label: 1, typeName: ".google.protobuf.FieldOptions.CType", defaultValue: "STRING" }, { name: "packed", number: 2, type: 8, label: 1 }, { name: "jstype", number: 6, type: 14, label: 1, typeName: ".google.protobuf.FieldOptions.JSType", defaultValue: "JS_NORMAL" }, { name: "lazy", number: 5, type: 8, label: 1, defaultValue: "false" }, { name: "unverified_lazy", number: 15, type: 8, label: 1, defaultValue: "false" }, { name: "deprecated", number: 3, type: 8, label: 1, defaultValue: "false" }, { name: "weak", number: 10, type: 8, label: 1, defaultValue: "false", options: { deprecated: true } }, { name: "debug_redact", number: 16, type: 8, label: 1, defaultValue: "false" }, { name: "retention", number: 17, type: 14, label: 1, typeName: ".google.protobuf.FieldOptions.OptionRetention" }, { name: "targets", number: 19, type: 14, label: 3, typeName: ".google.protobuf.FieldOptions.OptionTargetType" }, { name: "edition_defaults", number: 20, type: 11, label: 3, typeName: ".google.protobuf.FieldOptions.EditionDefault" }, { name: "features", number: 21, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "feature_support", number: 22, type: 11, label: 1, typeName: ".google.protobuf.FieldOptions.FeatureSupport" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], nestedType: [{ name: "EditionDefault", field: [{ name: "edition", number: 3, type: 14, label: 1, typeName: ".google.protobuf.Edition" }, { name: "value", number: 2, type: 9, label: 1 }] }, { name: "FeatureSupport", field: [{ name: "edition_introduced", number: 1, type: 14, label: 1, typeName: ".google.protobuf.Edition" }, { name: "edition_deprecated", number: 2, type: 14, label: 1, typeName: ".google.protobuf.Edition" }, { name: "deprecation_warning", number: 3, type: 9, label: 1 }, { name: "edition_removed", number: 4, type: 14, label: 1, typeName: ".google.protobuf.Edition" }] }], enumType: [{ name: "CType", value: [{ name: "STRING", number: 0 }, { name: "CORD", number: 1 }, { name: "STRING_PIECE", number: 2 }] }, { name: "JSType", value: [{ name: "JS_NORMAL", number: 0 }, { name: "JS_STRING", number: 1 }, { name: "JS_NUMBER", number: 2 }] }, { name: "OptionRetention", value: [{ name: "RETENTION_UNKNOWN", number: 0 }, { name: "RETENTION_RUNTIME", number: 1 }, { name: "RETENTION_SOURCE", number: 2 }] }, { name: "OptionTargetType", value: [{ name: "TARGET_TYPE_UNKNOWN", number: 0 }, { name: "TARGET_TYPE_FILE", number: 1 }, { name: "TARGET_TYPE_EXTENSION_RANGE", number: 2 }, { name: "TARGET_TYPE_MESSAGE", number: 3 }, { name: "TARGET_TYPE_FIELD", number: 4 }, { name: "TARGET_TYPE_ONEOF", number: 5 }, { name: "TARGET_TYPE_ENUM", number: 6 }, { name: "TARGET_TYPE_ENUM_ENTRY", number: 7 }, { name: "TARGET_TYPE_SERVICE", number: 8 }, { name: "TARGET_TYPE_METHOD", number: 9 }] }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "OneofOptions", field: [{ name: "features", number: 1, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "EnumOptions", field: [{ name: "allow_alias", number: 2, type: 8, label: 1 }, { name: "deprecated", number: 3, type: 8, label: 1, defaultValue: "false" }, { name: "deprecated_legacy_json_field_conflicts", number: 6, type: 8, label: 1, options: { deprecated: true } }, { name: "features", number: 7, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "EnumValueOptions", field: [{ name: "deprecated", number: 1, type: 8, label: 1, defaultValue: "false" }, { name: "features", number: 2, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "debug_redact", number: 3, type: 8, label: 1, defaultValue: "false" }, { name: "feature_support", number: 4, type: 11, label: 1, typeName: ".google.protobuf.FieldOptions.FeatureSupport" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "ServiceOptions", field: [{ name: "features", number: 34, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "deprecated", number: 33, type: 8, label: 1, defaultValue: "false" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "MethodOptions", field: [{ name: "deprecated", number: 33, type: 8, label: 1, defaultValue: "false" }, { name: "idempotency_level", number: 34, type: 14, label: 1, typeName: ".google.protobuf.MethodOptions.IdempotencyLevel", defaultValue: "IDEMPOTENCY_UNKNOWN" }, { name: "features", number: 35, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "uninterpreted_option", number: 999, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption" }], enumType: [{ name: "IdempotencyLevel", value: [{ name: "IDEMPOTENCY_UNKNOWN", number: 0 }, { name: "NO_SIDE_EFFECTS", number: 1 }, { name: "IDEMPOTENT", number: 2 }] }], extensionRange: [{ start: 1000, end: 536870912 }] }, { name: "UninterpretedOption", field: [{ name: "name", number: 2, type: 11, label: 3, typeName: ".google.protobuf.UninterpretedOption.NamePart" }, { name: "identifier_value", number: 3, type: 9, label: 1 }, { name: "positive_int_value", number: 4, type: 4, label: 1 }, { name: "negative_int_value", number: 5, type: 3, label: 1 }, { name: "double_value", number: 6, type: 1, label: 1 }, { name: "string_value", number: 7, type: 12, label: 1 }, { name: "aggregate_value", number: 8, type: 9, label: 1 }], nestedType: [{ name: "NamePart", field: [{ name: "name_part", number: 1, type: 9, label: 2 }, { name: "is_extension", number: 2, type: 8, label: 2 }] }] }, { name: "FeatureSet", field: [{ name: "field_presence", number: 1, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.FieldPresence", options: { retention: 1, targets: [4, 1], editionDefaults: [{ value: "EXPLICIT", edition: 900 }, { value: "IMPLICIT", edition: 999 }, { value: "EXPLICIT", edition: 1000 }] } }, { name: "enum_type", number: 2, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.EnumType", options: { retention: 1, targets: [6, 1], editionDefaults: [{ value: "CLOSED", edition: 900 }, { value: "OPEN", edition: 999 }] } }, { name: "repeated_field_encoding", number: 3, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.RepeatedFieldEncoding", options: { retention: 1, targets: [4, 1], editionDefaults: [{ value: "EXPANDED", edition: 900 }, { value: "PACKED", edition: 999 }] } }, { name: "utf8_validation", number: 4, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.Utf8Validation", options: { retention: 1, targets: [4, 1], editionDefaults: [{ value: "NONE", edition: 900 }, { value: "VERIFY", edition: 999 }] } }, { name: "message_encoding", number: 5, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.MessageEncoding", options: { retention: 1, targets: [4, 1], editionDefaults: [{ value: "LENGTH_PREFIXED", edition: 900 }] } }, { name: "json_format", number: 6, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.JsonFormat", options: { retention: 1, targets: [3, 6, 1], editionDefaults: [{ value: "LEGACY_BEST_EFFORT", edition: 900 }, { value: "ALLOW", edition: 999 }] } }, { name: "enforce_naming_style", number: 7, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.EnforceNamingStyle", options: { retention: 2, targets: [1, 2, 3, 4, 5, 6, 7, 8, 9], editionDefaults: [{ value: "STYLE_LEGACY", edition: 900 }, { value: "STYLE2024", edition: 1001 }] } }, { name: "default_symbol_visibility", number: 8, type: 14, label: 1, typeName: ".google.protobuf.FeatureSet.VisibilityFeature.DefaultSymbolVisibility", options: { retention: 2, targets: [1], editionDefaults: [{ value: "EXPORT_ALL", edition: 900 }, { value: "EXPORT_TOP_LEVEL", edition: 1001 }] } }], nestedType: [{ name: "VisibilityFeature", enumType: [{ name: "DefaultSymbolVisibility", value: [{ name: "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN", number: 0 }, { name: "EXPORT_ALL", number: 1 }, { name: "EXPORT_TOP_LEVEL", number: 2 }, { name: "LOCAL_ALL", number: 3 }, { name: "STRICT", number: 4 }] }] }], enumType: [{ name: "FieldPresence", value: [{ name: "FIELD_PRESENCE_UNKNOWN", number: 0 }, { name: "EXPLICIT", number: 1 }, { name: "IMPLICIT", number: 2 }, { name: "LEGACY_REQUIRED", number: 3 }] }, { name: "EnumType", value: [{ name: "ENUM_TYPE_UNKNOWN", number: 0 }, { name: "OPEN", number: 1 }, { name: "CLOSED", number: 2 }] }, { name: "RepeatedFieldEncoding", value: [{ name: "REPEATED_FIELD_ENCODING_UNKNOWN", number: 0 }, { name: "PACKED", number: 1 }, { name: "EXPANDED", number: 2 }] }, { name: "Utf8Validation", value: [{ name: "UTF8_VALIDATION_UNKNOWN", number: 0 }, { name: "VERIFY", number: 2 }, { name: "NONE", number: 3 }] }, { name: "MessageEncoding", value: [{ name: "MESSAGE_ENCODING_UNKNOWN", number: 0 }, { name: "LENGTH_PREFIXED", number: 1 }, { name: "DELIMITED", number: 2 }] }, { name: "JsonFormat", value: [{ name: "JSON_FORMAT_UNKNOWN", number: 0 }, { name: "ALLOW", number: 1 }, { name: "LEGACY_BEST_EFFORT", number: 2 }] }, { name: "EnforceNamingStyle", value: [{ name: "ENFORCE_NAMING_STYLE_UNKNOWN", number: 0 }, { name: "STYLE2024", number: 1 }, { name: "STYLE_LEGACY", number: 2 }] }], extensionRange: [{ start: 1000, end: 9995 }, { start: 9995, end: 1e4 }, { start: 1e4, end: 10001 }] }, { name: "FeatureSetDefaults", field: [{ name: "defaults", number: 1, type: 11, label: 3, typeName: ".google.protobuf.FeatureSetDefaults.FeatureSetEditionDefault" }, { name: "minimum_edition", number: 4, type: 14, label: 1, typeName: ".google.protobuf.Edition" }, { name: "maximum_edition", number: 5, type: 14, label: 1, typeName: ".google.protobuf.Edition" }], nestedType: [{ name: "FeatureSetEditionDefault", field: [{ name: "edition", number: 3, type: 14, label: 1, typeName: ".google.protobuf.Edition" }, { name: "overridable_features", number: 4, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }, { name: "fixed_features", number: 5, type: 11, label: 1, typeName: ".google.protobuf.FeatureSet" }] }] }, { name: "SourceCodeInfo", field: [{ name: "location", number: 1, type: 11, label: 3, typeName: ".google.protobuf.SourceCodeInfo.Location" }], nestedType: [{ name: "Location", field: [{ name: "path", number: 1, type: 5, label: 3, options: { packed: true } }, { name: "span", number: 2, type: 5, label: 3, options: { packed: true } }, { name: "leading_comments", number: 3, type: 9, label: 1 }, { name: "trailing_comments", number: 4, type: 9, label: 1 }, { name: "leading_detached_comments", number: 6, type: 9, label: 3 }] }], extensionRange: [{ start: 536000000, end: 536000001 }] }, { name: "GeneratedCodeInfo", field: [{ name: "annotation", number: 1, type: 11, label: 3, typeName: ".google.protobuf.GeneratedCodeInfo.Annotation" }], nestedType: [{ name: "Annotation", field: [{ name: "path", number: 1, type: 5, label: 3, options: { packed: true } }, { name: "source_file", number: 2, type: 9, label: 1 }, { name: "begin", number: 3, type: 5, label: 1 }, { name: "end", number: 4, type: 5, label: 1 }, { name: "semantic", number: 5, type: 14, label: 1, typeName: ".google.protobuf.GeneratedCodeInfo.Annotation.Semantic" }], enumType: [{ name: "Semantic", value: [{ name: "NONE", number: 0 }, { name: "SET", number: 1 }, { name: "ALIAS", number: 2 }] }] }] }], enumType: [{ name: "Edition", value: [{ name: "EDITION_UNKNOWN", number: 0 }, { name: "EDITION_LEGACY", number: 900 }, { name: "EDITION_PROTO2", number: 998 }, { name: "EDITION_PROTO3", number: 999 }, { name: "EDITION_2023", number: 1000 }, { name: "EDITION_2024", number: 1001 }, { name: "EDITION_UNSTABLE", number: 9999 }, { name: "EDITION_1_TEST_ONLY", number: 1 }, { name: "EDITION_2_TEST_ONLY", number: 2 }, { name: "EDITION_99997_TEST_ONLY", number: 99997 }, { name: "EDITION_99998_TEST_ONLY", number: 99998 }, { name: "EDITION_99999_TEST_ONLY", number: 99999 }, { name: "EDITION_MAX", number: 2147483647 }] }, { name: "SymbolVisibility", value: [{ name: "VISIBILITY_UNSET", number: 0 }, { name: "VISIBILITY_LOCAL", number: 1 }, { name: "VISIBILITY_EXPORT", number: 2 }] }] });
var FileDescriptorProtoSchema = /* @__PURE__ */ messageDesc(file_google_protobuf_descriptor, 1);
var ExtensionRangeOptions_VerificationState;
(function(ExtensionRangeOptions_VerificationState2) {
  ExtensionRangeOptions_VerificationState2[ExtensionRangeOptions_VerificationState2["DECLARATION"] = 0] = "DECLARATION";
  ExtensionRangeOptions_VerificationState2[ExtensionRangeOptions_VerificationState2["UNVERIFIED"] = 1] = "UNVERIFIED";
})(ExtensionRangeOptions_VerificationState || (ExtensionRangeOptions_VerificationState = {}));
var FieldDescriptorProto_Type;
(function(FieldDescriptorProto_Type2) {
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["DOUBLE"] = 1] = "DOUBLE";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["FLOAT"] = 2] = "FLOAT";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["INT64"] = 3] = "INT64";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["UINT64"] = 4] = "UINT64";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["INT32"] = 5] = "INT32";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["FIXED64"] = 6] = "FIXED64";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["FIXED32"] = 7] = "FIXED32";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["BOOL"] = 8] = "BOOL";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["STRING"] = 9] = "STRING";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["GROUP"] = 10] = "GROUP";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["MESSAGE"] = 11] = "MESSAGE";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["BYTES"] = 12] = "BYTES";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["UINT32"] = 13] = "UINT32";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["ENUM"] = 14] = "ENUM";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SFIXED32"] = 15] = "SFIXED32";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SFIXED64"] = 16] = "SFIXED64";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SINT32"] = 17] = "SINT32";
  FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SINT64"] = 18] = "SINT64";
})(FieldDescriptorProto_Type || (FieldDescriptorProto_Type = {}));
var FieldDescriptorProto_Label;
(function(FieldDescriptorProto_Label2) {
  FieldDescriptorProto_Label2[FieldDescriptorProto_Label2["OPTIONAL"] = 1] = "OPTIONAL";
  FieldDescriptorProto_Label2[FieldDescriptorProto_Label2["REPEATED"] = 3] = "REPEATED";
  FieldDescriptorProto_Label2[FieldDescriptorProto_Label2["REQUIRED"] = 2] = "REQUIRED";
})(FieldDescriptorProto_Label || (FieldDescriptorProto_Label = {}));
var FileOptions_OptimizeMode;
(function(FileOptions_OptimizeMode2) {
  FileOptions_OptimizeMode2[FileOptions_OptimizeMode2["SPEED"] = 1] = "SPEED";
  FileOptions_OptimizeMode2[FileOptions_OptimizeMode2["CODE_SIZE"] = 2] = "CODE_SIZE";
  FileOptions_OptimizeMode2[FileOptions_OptimizeMode2["LITE_RUNTIME"] = 3] = "LITE_RUNTIME";
})(FileOptions_OptimizeMode || (FileOptions_OptimizeMode = {}));
var FieldOptions_CType;
(function(FieldOptions_CType2) {
  FieldOptions_CType2[FieldOptions_CType2["STRING"] = 0] = "STRING";
  FieldOptions_CType2[FieldOptions_CType2["CORD"] = 1] = "CORD";
  FieldOptions_CType2[FieldOptions_CType2["STRING_PIECE"] = 2] = "STRING_PIECE";
})(FieldOptions_CType || (FieldOptions_CType = {}));
var FieldOptions_JSType;
(function(FieldOptions_JSType2) {
  FieldOptions_JSType2[FieldOptions_JSType2["JS_NORMAL"] = 0] = "JS_NORMAL";
  FieldOptions_JSType2[FieldOptions_JSType2["JS_STRING"] = 1] = "JS_STRING";
  FieldOptions_JSType2[FieldOptions_JSType2["JS_NUMBER"] = 2] = "JS_NUMBER";
})(FieldOptions_JSType || (FieldOptions_JSType = {}));
var FieldOptions_OptionRetention;
(function(FieldOptions_OptionRetention2) {
  FieldOptions_OptionRetention2[FieldOptions_OptionRetention2["RETENTION_UNKNOWN"] = 0] = "RETENTION_UNKNOWN";
  FieldOptions_OptionRetention2[FieldOptions_OptionRetention2["RETENTION_RUNTIME"] = 1] = "RETENTION_RUNTIME";
  FieldOptions_OptionRetention2[FieldOptions_OptionRetention2["RETENTION_SOURCE"] = 2] = "RETENTION_SOURCE";
})(FieldOptions_OptionRetention || (FieldOptions_OptionRetention = {}));
var FieldOptions_OptionTargetType;
(function(FieldOptions_OptionTargetType2) {
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_UNKNOWN"] = 0] = "TARGET_TYPE_UNKNOWN";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_FILE"] = 1] = "TARGET_TYPE_FILE";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_EXTENSION_RANGE"] = 2] = "TARGET_TYPE_EXTENSION_RANGE";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_MESSAGE"] = 3] = "TARGET_TYPE_MESSAGE";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_FIELD"] = 4] = "TARGET_TYPE_FIELD";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_ONEOF"] = 5] = "TARGET_TYPE_ONEOF";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_ENUM"] = 6] = "TARGET_TYPE_ENUM";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_ENUM_ENTRY"] = 7] = "TARGET_TYPE_ENUM_ENTRY";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_SERVICE"] = 8] = "TARGET_TYPE_SERVICE";
  FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_METHOD"] = 9] = "TARGET_TYPE_METHOD";
})(FieldOptions_OptionTargetType || (FieldOptions_OptionTargetType = {}));
var MethodOptions_IdempotencyLevel;
(function(MethodOptions_IdempotencyLevel2) {
  MethodOptions_IdempotencyLevel2[MethodOptions_IdempotencyLevel2["IDEMPOTENCY_UNKNOWN"] = 0] = "IDEMPOTENCY_UNKNOWN";
  MethodOptions_IdempotencyLevel2[MethodOptions_IdempotencyLevel2["NO_SIDE_EFFECTS"] = 1] = "NO_SIDE_EFFECTS";
  MethodOptions_IdempotencyLevel2[MethodOptions_IdempotencyLevel2["IDEMPOTENT"] = 2] = "IDEMPOTENT";
})(MethodOptions_IdempotencyLevel || (MethodOptions_IdempotencyLevel = {}));
var FeatureSet_VisibilityFeature_DefaultSymbolVisibility;
(function(FeatureSet_VisibilityFeature_DefaultSymbolVisibility2) {
  FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["DEFAULT_SYMBOL_VISIBILITY_UNKNOWN"] = 0] = "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN";
  FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["EXPORT_ALL"] = 1] = "EXPORT_ALL";
  FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["EXPORT_TOP_LEVEL"] = 2] = "EXPORT_TOP_LEVEL";
  FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["LOCAL_ALL"] = 3] = "LOCAL_ALL";
  FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["STRICT"] = 4] = "STRICT";
})(FeatureSet_VisibilityFeature_DefaultSymbolVisibility || (FeatureSet_VisibilityFeature_DefaultSymbolVisibility = {}));
var FeatureSet_FieldPresence;
(function(FeatureSet_FieldPresence2) {
  FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["FIELD_PRESENCE_UNKNOWN"] = 0] = "FIELD_PRESENCE_UNKNOWN";
  FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["EXPLICIT"] = 1] = "EXPLICIT";
  FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["IMPLICIT"] = 2] = "IMPLICIT";
  FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["LEGACY_REQUIRED"] = 3] = "LEGACY_REQUIRED";
})(FeatureSet_FieldPresence || (FeatureSet_FieldPresence = {}));
var FeatureSet_EnumType;
(function(FeatureSet_EnumType2) {
  FeatureSet_EnumType2[FeatureSet_EnumType2["ENUM_TYPE_UNKNOWN"] = 0] = "ENUM_TYPE_UNKNOWN";
  FeatureSet_EnumType2[FeatureSet_EnumType2["OPEN"] = 1] = "OPEN";
  FeatureSet_EnumType2[FeatureSet_EnumType2["CLOSED"] = 2] = "CLOSED";
})(FeatureSet_EnumType || (FeatureSet_EnumType = {}));
var FeatureSet_RepeatedFieldEncoding;
(function(FeatureSet_RepeatedFieldEncoding2) {
  FeatureSet_RepeatedFieldEncoding2[FeatureSet_RepeatedFieldEncoding2["REPEATED_FIELD_ENCODING_UNKNOWN"] = 0] = "REPEATED_FIELD_ENCODING_UNKNOWN";
  FeatureSet_RepeatedFieldEncoding2[FeatureSet_RepeatedFieldEncoding2["PACKED"] = 1] = "PACKED";
  FeatureSet_RepeatedFieldEncoding2[FeatureSet_RepeatedFieldEncoding2["EXPANDED"] = 2] = "EXPANDED";
})(FeatureSet_RepeatedFieldEncoding || (FeatureSet_RepeatedFieldEncoding = {}));
var FeatureSet_Utf8Validation;
(function(FeatureSet_Utf8Validation2) {
  FeatureSet_Utf8Validation2[FeatureSet_Utf8Validation2["UTF8_VALIDATION_UNKNOWN"] = 0] = "UTF8_VALIDATION_UNKNOWN";
  FeatureSet_Utf8Validation2[FeatureSet_Utf8Validation2["VERIFY"] = 2] = "VERIFY";
  FeatureSet_Utf8Validation2[FeatureSet_Utf8Validation2["NONE"] = 3] = "NONE";
})(FeatureSet_Utf8Validation || (FeatureSet_Utf8Validation = {}));
var FeatureSet_MessageEncoding;
(function(FeatureSet_MessageEncoding2) {
  FeatureSet_MessageEncoding2[FeatureSet_MessageEncoding2["MESSAGE_ENCODING_UNKNOWN"] = 0] = "MESSAGE_ENCODING_UNKNOWN";
  FeatureSet_MessageEncoding2[FeatureSet_MessageEncoding2["LENGTH_PREFIXED"] = 1] = "LENGTH_PREFIXED";
  FeatureSet_MessageEncoding2[FeatureSet_MessageEncoding2["DELIMITED"] = 2] = "DELIMITED";
})(FeatureSet_MessageEncoding || (FeatureSet_MessageEncoding = {}));
var FeatureSet_JsonFormat;
(function(FeatureSet_JsonFormat2) {
  FeatureSet_JsonFormat2[FeatureSet_JsonFormat2["JSON_FORMAT_UNKNOWN"] = 0] = "JSON_FORMAT_UNKNOWN";
  FeatureSet_JsonFormat2[FeatureSet_JsonFormat2["ALLOW"] = 1] = "ALLOW";
  FeatureSet_JsonFormat2[FeatureSet_JsonFormat2["LEGACY_BEST_EFFORT"] = 2] = "LEGACY_BEST_EFFORT";
})(FeatureSet_JsonFormat || (FeatureSet_JsonFormat = {}));
var FeatureSet_EnforceNamingStyle;
(function(FeatureSet_EnforceNamingStyle2) {
  FeatureSet_EnforceNamingStyle2[FeatureSet_EnforceNamingStyle2["ENFORCE_NAMING_STYLE_UNKNOWN"] = 0] = "ENFORCE_NAMING_STYLE_UNKNOWN";
  FeatureSet_EnforceNamingStyle2[FeatureSet_EnforceNamingStyle2["STYLE2024"] = 1] = "STYLE2024";
  FeatureSet_EnforceNamingStyle2[FeatureSet_EnforceNamingStyle2["STYLE_LEGACY"] = 2] = "STYLE_LEGACY";
})(FeatureSet_EnforceNamingStyle || (FeatureSet_EnforceNamingStyle = {}));
var GeneratedCodeInfo_Annotation_Semantic;
(function(GeneratedCodeInfo_Annotation_Semantic2) {
  GeneratedCodeInfo_Annotation_Semantic2[GeneratedCodeInfo_Annotation_Semantic2["NONE"] = 0] = "NONE";
  GeneratedCodeInfo_Annotation_Semantic2[GeneratedCodeInfo_Annotation_Semantic2["SET"] = 1] = "SET";
  GeneratedCodeInfo_Annotation_Semantic2[GeneratedCodeInfo_Annotation_Semantic2["ALIAS"] = 2] = "ALIAS";
})(GeneratedCodeInfo_Annotation_Semantic || (GeneratedCodeInfo_Annotation_Semantic = {}));
var Edition;
(function(Edition2) {
  Edition2[Edition2["EDITION_UNKNOWN"] = 0] = "EDITION_UNKNOWN";
  Edition2[Edition2["EDITION_LEGACY"] = 900] = "EDITION_LEGACY";
  Edition2[Edition2["EDITION_PROTO2"] = 998] = "EDITION_PROTO2";
  Edition2[Edition2["EDITION_PROTO3"] = 999] = "EDITION_PROTO3";
  Edition2[Edition2["EDITION_2023"] = 1000] = "EDITION_2023";
  Edition2[Edition2["EDITION_2024"] = 1001] = "EDITION_2024";
  Edition2[Edition2["EDITION_UNSTABLE"] = 9999] = "EDITION_UNSTABLE";
  Edition2[Edition2["EDITION_1_TEST_ONLY"] = 1] = "EDITION_1_TEST_ONLY";
  Edition2[Edition2["EDITION_2_TEST_ONLY"] = 2] = "EDITION_2_TEST_ONLY";
  Edition2[Edition2["EDITION_99997_TEST_ONLY"] = 99997] = "EDITION_99997_TEST_ONLY";
  Edition2[Edition2["EDITION_99998_TEST_ONLY"] = 99998] = "EDITION_99998_TEST_ONLY";
  Edition2[Edition2["EDITION_99999_TEST_ONLY"] = 99999] = "EDITION_99999_TEST_ONLY";
  Edition2[Edition2["EDITION_MAX"] = 2147483647] = "EDITION_MAX";
})(Edition || (Edition = {}));
var SymbolVisibility;
(function(SymbolVisibility2) {
  SymbolVisibility2[SymbolVisibility2["VISIBILITY_UNSET"] = 0] = "VISIBILITY_UNSET";
  SymbolVisibility2[SymbolVisibility2["VISIBILITY_LOCAL"] = 1] = "VISIBILITY_LOCAL";
  SymbolVisibility2[SymbolVisibility2["VISIBILITY_EXPORT"] = 2] = "VISIBILITY_EXPORT";
})(SymbolVisibility || (SymbolVisibility = {}));

// node_modules/@bufbuild/protobuf/dist/esm/from-binary.js
var readDefaults = {
  readUnknownFields: true
};
function makeReadOptions(options) {
  return options ? Object.assign(Object.assign({}, readDefaults), options) : readDefaults;
}
function fromBinary(schema, bytes, options) {
  const msg = reflect(schema, undefined, false);
  readMessage(msg, new BinaryReader(bytes), makeReadOptions(options), false, bytes.byteLength);
  return msg.message;
}
function readMessage(message, reader, options, delimited, lengthOrDelimitedFieldNo) {
  var _a;
  const end = delimited ? reader.len : reader.pos + lengthOrDelimitedFieldNo;
  let fieldNo;
  let wireType;
  const unknownFields = (_a = message.getUnknown()) !== null && _a !== undefined ? _a : [];
  while (reader.pos < end) {
    [fieldNo, wireType] = reader.tag();
    if (delimited && wireType == WireType.EndGroup) {
      break;
    }
    const field = message.findNumber(fieldNo);
    if (!field) {
      const data = reader.skip(wireType, fieldNo);
      if (options.readUnknownFields) {
        unknownFields.push({ no: fieldNo, wireType, data });
      }
      continue;
    }
    readField(message, reader, field, wireType, options);
  }
  if (delimited) {
    if (wireType != WireType.EndGroup || fieldNo !== lengthOrDelimitedFieldNo) {
      throw new Error("invalid end group tag");
    }
  }
  if (unknownFields.length > 0) {
    message.setUnknown(unknownFields);
  }
}
function readField(message, reader, field, wireType, options) {
  var _a;
  switch (field.fieldKind) {
    case "scalar":
      message.set(field, readScalar(reader, field.scalar));
      break;
    case "enum":
      const val = readScalar(reader, ScalarType.INT32);
      if (field.enum.open) {
        message.set(field, val);
      } else {
        const ok = field.enum.values.some((v) => v.number === val);
        if (ok) {
          message.set(field, val);
        } else if (options.readUnknownFields) {
          const bytes = [];
          varint32write(val, bytes);
          const unknownFields = (_a = message.getUnknown()) !== null && _a !== undefined ? _a : [];
          unknownFields.push({
            no: field.number,
            wireType,
            data: new Uint8Array(bytes)
          });
          message.setUnknown(unknownFields);
        }
      }
      break;
    case "message":
      message.set(field, readMessageField(reader, options, field, message.get(field)));
      break;
    case "list":
      readListField(reader, wireType, message.get(field), options);
      break;
    case "map":
      readMapEntry(reader, message.get(field), options);
      break;
  }
}
function readMapEntry(reader, map, options) {
  const field = map.field();
  let key;
  let val;
  const len = reader.uint32();
  const end = reader.pos + len;
  while (reader.pos < end) {
    const [fieldNo] = reader.tag();
    switch (fieldNo) {
      case 1:
        key = readScalar(reader, field.mapKey);
        break;
      case 2:
        switch (field.mapKind) {
          case "scalar":
            val = readScalar(reader, field.scalar);
            break;
          case "enum":
            val = reader.int32();
            break;
          case "message":
            val = readMessageField(reader, options, field);
            break;
        }
        break;
    }
  }
  if (key === undefined) {
    key = scalarZeroValue(field.mapKey, false);
  }
  if (val === undefined) {
    switch (field.mapKind) {
      case "scalar":
        val = scalarZeroValue(field.scalar, false);
        break;
      case "enum":
        val = field.enum.values[0].number;
        break;
      case "message":
        val = reflect(field.message, undefined, false);
        break;
    }
  }
  map.set(key, val);
}
function readListField(reader, wireType, list, options) {
  var _a;
  const field = list.field();
  if (field.listKind === "message") {
    list.add(readMessageField(reader, options, field));
    return;
  }
  const scalarType = (_a = field.scalar) !== null && _a !== undefined ? _a : ScalarType.INT32;
  const packed = wireType == WireType.LengthDelimited && scalarType != ScalarType.STRING && scalarType != ScalarType.BYTES;
  if (!packed) {
    list.add(readScalar(reader, scalarType));
    return;
  }
  const e = reader.uint32() + reader.pos;
  while (reader.pos < e) {
    list.add(readScalar(reader, scalarType));
  }
}
function readMessageField(reader, options, field, mergeMessage) {
  const delimited = field.delimitedEncoding;
  const message = mergeMessage !== null && mergeMessage !== undefined ? mergeMessage : reflect(field.message, undefined, false);
  readMessage(message, reader, options, delimited, delimited ? field.number : reader.uint32());
  return message;
}
function readScalar(reader, type) {
  switch (type) {
    case ScalarType.STRING:
      return reader.string();
    case ScalarType.BOOL:
      return reader.bool();
    case ScalarType.DOUBLE:
      return reader.double();
    case ScalarType.FLOAT:
      return reader.float();
    case ScalarType.INT32:
      return reader.int32();
    case ScalarType.INT64:
      return reader.int64();
    case ScalarType.UINT64:
      return reader.uint64();
    case ScalarType.FIXED64:
      return reader.fixed64();
    case ScalarType.BYTES:
      return reader.bytes();
    case ScalarType.FIXED32:
      return reader.fixed32();
    case ScalarType.SFIXED32:
      return reader.sfixed32();
    case ScalarType.SFIXED64:
      return reader.sfixed64();
    case ScalarType.SINT64:
      return reader.sint64();
    case ScalarType.UINT32:
      return reader.uint32();
    case ScalarType.SINT32:
      return reader.sint32();
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/codegenv2/file.js
function fileDesc(b64, imports) {
  var _a;
  const root = fromBinary(FileDescriptorProtoSchema, base64Decode(b64));
  root.messageType.forEach(restoreJsonNames);
  root.dependency = (_a = imports === null || imports === undefined ? undefined : imports.map((f) => f.proto.name)) !== null && _a !== undefined ? _a : [];
  const reg = createFileRegistry(root, (protoFileName) => imports === null || imports === undefined ? undefined : imports.find((f) => f.proto.name === protoFileName));
  return reg.getFile(root.name);
}

// node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/any_pb.js
var file_google_protobuf_any = /* @__PURE__ */ fileDesc("Chlnb29nbGUvcHJvdG9idWYvYW55LnByb3RvEg9nb29nbGUucHJvdG9idWYiJgoDQW55EhAKCHR5cGVfdXJsGAEgASgJEg0KBXZhbHVlGAIgASgMQnYKE2NvbS5nb29nbGUucHJvdG9idWZCCEFueVByb3RvUAFaLGdvb2dsZS5nb2xhbmcub3JnL3Byb3RvYnVmL3R5cGVzL2tub3duL2FueXBiogIDR1BCqgIeR29vZ2xlLlByb3RvYnVmLldlbGxLbm93blR5cGVzYgZwcm90bzM");
var AnySchema = /* @__PURE__ */ messageDesc(file_google_protobuf_any, 0);

// node_modules/@bufbuild/protobuf/dist/esm/to-binary.js
var LEGACY_REQUIRED2 = 3;
var writeDefaults = {
  writeUnknownFields: true
};
function makeWriteOptions(options) {
  return options ? Object.assign(Object.assign({}, writeDefaults), options) : writeDefaults;
}
function toBinary(schema, message, options) {
  return writeFields(new BinaryWriter, makeWriteOptions(options), reflect(schema, message)).finish();
}
function writeFields(writer, opts, msg) {
  var _a;
  for (const f of msg.sortedFields) {
    if (!msg.isSet(f)) {
      if (f.presence == LEGACY_REQUIRED2) {
        throw new Error(`cannot encode ${f} to binary: required field not set`);
      }
      continue;
    }
    writeField(writer, opts, msg, f);
  }
  if (opts.writeUnknownFields) {
    for (const { no, wireType, data } of (_a = msg.getUnknown()) !== null && _a !== undefined ? _a : []) {
      writer.tag(no, wireType).raw(data);
    }
  }
  return writer;
}
function writeField(writer, opts, msg, field) {
  var _a;
  switch (field.fieldKind) {
    case "scalar":
    case "enum":
      writeScalar(writer, msg.desc.typeName, field.name, (_a = field.scalar) !== null && _a !== undefined ? _a : ScalarType.INT32, field.number, msg.get(field));
      break;
    case "list":
      writeListField(writer, opts, field, msg.get(field));
      break;
    case "message":
      writeMessageField(writer, opts, field, msg.get(field));
      break;
    case "map":
      for (const [key, val] of msg.get(field)) {
        writeMapEntry(writer, opts, field, key, val);
      }
      break;
  }
}
function writeScalar(writer, msgName, fieldName, scalarType, fieldNo, value) {
  writeScalarValue(writer.tag(fieldNo, writeTypeOfScalar(scalarType)), msgName, fieldName, scalarType, value);
}
function writeMessageField(writer, opts, field, message) {
  if (field.delimitedEncoding) {
    writeFields(writer.tag(field.number, WireType.StartGroup), opts, message).tag(field.number, WireType.EndGroup);
  } else {
    writeFields(writer.tag(field.number, WireType.LengthDelimited).fork(), opts, message).join();
  }
}
function writeListField(writer, opts, field, list) {
  var _a;
  if (field.listKind == "message") {
    for (const item of list) {
      writeMessageField(writer, opts, field, item);
    }
    return;
  }
  const scalarType = (_a = field.scalar) !== null && _a !== undefined ? _a : ScalarType.INT32;
  if (field.packed) {
    if (!list.size) {
      return;
    }
    writer.tag(field.number, WireType.LengthDelimited).fork();
    for (const item of list) {
      writeScalarValue(writer, field.parent.typeName, field.name, scalarType, item);
    }
    writer.join();
    return;
  }
  for (const item of list) {
    writeScalar(writer, field.parent.typeName, field.name, scalarType, field.number, item);
  }
}
function writeMapEntry(writer, opts, field, key, value) {
  var _a;
  writer.tag(field.number, WireType.LengthDelimited).fork();
  writeScalar(writer, field.parent.typeName, field.name, field.mapKey, 1, key);
  switch (field.mapKind) {
    case "scalar":
    case "enum":
      writeScalar(writer, field.parent.typeName, field.name, (_a = field.scalar) !== null && _a !== undefined ? _a : ScalarType.INT32, 2, value);
      break;
    case "message":
      writeFields(writer.tag(2, WireType.LengthDelimited).fork(), opts, value).join();
      break;
  }
  writer.join();
}
function writeScalarValue(writer, msgName, fieldName, type, value) {
  try {
    switch (type) {
      case ScalarType.STRING:
        writer.string(value);
        break;
      case ScalarType.BOOL:
        writer.bool(value);
        break;
      case ScalarType.DOUBLE:
        writer.double(value);
        break;
      case ScalarType.FLOAT:
        writer.float(value);
        break;
      case ScalarType.INT32:
        writer.int32(value);
        break;
      case ScalarType.INT64:
        writer.int64(value);
        break;
      case ScalarType.UINT64:
        writer.uint64(value);
        break;
      case ScalarType.FIXED64:
        writer.fixed64(value);
        break;
      case ScalarType.BYTES:
        writer.bytes(value);
        break;
      case ScalarType.FIXED32:
        writer.fixed32(value);
        break;
      case ScalarType.SFIXED32:
        writer.sfixed32(value);
        break;
      case ScalarType.SFIXED64:
        writer.sfixed64(value);
        break;
      case ScalarType.SINT64:
        writer.sint64(value);
        break;
      case ScalarType.UINT32:
        writer.uint32(value);
        break;
      case ScalarType.SINT32:
        writer.sint32(value);
        break;
    }
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`cannot encode field ${msgName}.${fieldName} to binary: ${e.message}`);
    }
    throw e;
  }
}
function writeTypeOfScalar(type) {
  switch (type) {
    case ScalarType.BYTES:
    case ScalarType.STRING:
      return WireType.LengthDelimited;
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return WireType.Bit64;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.FLOAT:
      return WireType.Bit32;
    default:
      return WireType.Varint;
  }
}

// node_modules/@bufbuild/protobuf/dist/esm/wkt/any.js
function anyPack(schema, message, into) {
  let ret = false;
  if (!into) {
    into = create(AnySchema);
    ret = true;
  }
  into.value = toBinary(schema, message);
  into.typeUrl = typeNameToUrl(message.$typeName);
  return ret ? into : undefined;
}
function anyIs(any, descOrTypeName) {
  if (any.typeUrl === "") {
    return false;
  }
  const want = typeof descOrTypeName == "string" ? descOrTypeName : descOrTypeName.typeName;
  const got = typeUrlToName(any.typeUrl);
  return want === got;
}
function anyUnpack(any, registryOrMessageDesc) {
  if (any.typeUrl === "") {
    return;
  }
  const desc = registryOrMessageDesc.kind == "message" ? registryOrMessageDesc : registryOrMessageDesc.getMessage(typeUrlToName(any.typeUrl));
  if (!desc || !anyIs(any, desc)) {
    return;
  }
  return fromBinary(desc, any.value);
}
function typeNameToUrl(name) {
  return `type.googleapis.com/${name}`;
}
function typeUrlToName(url) {
  const slash = url.lastIndexOf("/");
  const name = slash >= 0 ? url.substring(slash + 1) : url;
  if (!name.length) {
    throw new Error(`invalid type url: ${url}`);
  }
  return name;
}

// node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/struct_pb.js
var file_google_protobuf_struct = /* @__PURE__ */ fileDesc("Chxnb29nbGUvcHJvdG9idWYvc3RydWN0LnByb3RvEg9nb29nbGUucHJvdG9idWYihAEKBlN0cnVjdBIzCgZmaWVsZHMYASADKAsyIy5nb29nbGUucHJvdG9idWYuU3RydWN0LkZpZWxkc0VudHJ5GkUKC0ZpZWxkc0VudHJ5EgsKA2tleRgBIAEoCRIlCgV2YWx1ZRgCIAEoCzIWLmdvb2dsZS5wcm90b2J1Zi5WYWx1ZToCOAEi6gEKBVZhbHVlEjAKCm51bGxfdmFsdWUYASABKA4yGi5nb29nbGUucHJvdG9idWYuTnVsbFZhbHVlSAASFgoMbnVtYmVyX3ZhbHVlGAIgASgBSAASFgoMc3RyaW5nX3ZhbHVlGAMgASgJSAASFAoKYm9vbF92YWx1ZRgEIAEoCEgAEi8KDHN0cnVjdF92YWx1ZRgFIAEoCzIXLmdvb2dsZS5wcm90b2J1Zi5TdHJ1Y3RIABIwCgpsaXN0X3ZhbHVlGAYgASgLMhouZ29vZ2xlLnByb3RvYnVmLkxpc3RWYWx1ZUgAQgYKBGtpbmQiMwoJTGlzdFZhbHVlEiYKBnZhbHVlcxgBIAMoCzIWLmdvb2dsZS5wcm90b2J1Zi5WYWx1ZSobCglOdWxsVmFsdWUSDgoKTlVMTF9WQUxVRRAAQn8KE2NvbS5nb29nbGUucHJvdG9idWZCC1N0cnVjdFByb3RvUAFaL2dvb2dsZS5nb2xhbmcub3JnL3Byb3RvYnVmL3R5cGVzL2tub3duL3N0cnVjdHBi+AEBogIDR1BCqgIeR29vZ2xlLlByb3RvYnVmLldlbGxLbm93blR5cGVzYgZwcm90bzM");
var StructSchema = /* @__PURE__ */ messageDesc(file_google_protobuf_struct, 0);
var ValueSchema = /* @__PURE__ */ messageDesc(file_google_protobuf_struct, 1);
var ListValueSchema = /* @__PURE__ */ messageDesc(file_google_protobuf_struct, 2);
var NullValue;
(function(NullValue2) {
  NullValue2[NullValue2["NULL_VALUE"] = 0] = "NULL_VALUE";
})(NullValue || (NullValue = {}));

// node_modules/@bufbuild/protobuf/dist/esm/extensions.js
function getExtension(message, extension) {
  assertExtendee(extension, message);
  const ufs = filterUnknownFields(message.$unknown, extension);
  const [container, field, get] = createExtensionContainer(extension);
  for (const uf of ufs) {
    readField(container, new BinaryReader(uf.data), field, uf.wireType, {
      readUnknownFields: true
    });
  }
  return get();
}
function setExtension(message, extension, value) {
  var _a;
  assertExtendee(extension, message);
  const ufs = ((_a = message.$unknown) !== null && _a !== undefined ? _a : []).filter((uf) => uf.no !== extension.number);
  const [container, field] = createExtensionContainer(extension, value);
  const writer = new BinaryWriter;
  writeField(writer, { writeUnknownFields: true }, container, field);
  const reader = new BinaryReader(writer.finish());
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    const data = reader.skip(wireType, no);
    ufs.push({ no, wireType, data });
  }
  message.$unknown = ufs;
}
function filterUnknownFields(unknownFields, extension) {
  if (unknownFields === undefined)
    return [];
  if (extension.fieldKind === "enum" || extension.fieldKind === "scalar") {
    for (let i = unknownFields.length - 1;i >= 0; --i) {
      if (unknownFields[i].no == extension.number) {
        return [unknownFields[i]];
      }
    }
    return [];
  }
  return unknownFields.filter((uf) => uf.no === extension.number);
}
function createExtensionContainer(extension, value) {
  const localName = extension.typeName;
  const field = Object.assign(Object.assign({}, extension), { kind: "field", parent: extension.extendee, localName });
  const desc = Object.assign(Object.assign({}, extension.extendee), { fields: [field], members: [field], oneofs: [] });
  const container = create(desc, value !== undefined ? { [localName]: value } : undefined);
  return [
    reflect(desc, container),
    field,
    () => {
      const value2 = container[localName];
      if (value2 === undefined) {
        const desc2 = extension.message;
        if (isWrapperDesc(desc2)) {
          return scalarZeroValue(desc2.fields[0].scalar, desc2.fields[0].longAsString);
        }
        return create(desc2);
      }
      return value2;
    }
  ];
}
function assertExtendee(extension, message) {
  if (extension.extendee.typeName != message.$typeName) {
    throw new Error(`extension ${extension.typeName} can only be applied to message ${extension.extendee.typeName}`);
  }
}
// node_modules/@bufbuild/protobuf/dist/esm/to-json.js
var LEGACY_REQUIRED3 = 3;
var IMPLICIT4 = 2;
var jsonWriteDefaults = {
  alwaysEmitImplicit: false,
  enumAsInteger: false,
  useProtoFieldName: false
};
function makeWriteOptions2(options) {
  return options ? Object.assign(Object.assign({}, jsonWriteDefaults), options) : jsonWriteDefaults;
}
function toJson(schema, message, options) {
  return reflectToJson(reflect(schema, message), makeWriteOptions2(options));
}
function reflectToJson(msg, opts) {
  var _a;
  const wktJson = tryWktToJson(msg, opts);
  if (wktJson !== undefined)
    return wktJson;
  const json = {};
  for (const f of msg.sortedFields) {
    if (!msg.isSet(f)) {
      if (f.presence == LEGACY_REQUIRED3) {
        throw new Error(`cannot encode ${f} to JSON: required field not set`);
      }
      if (!opts.alwaysEmitImplicit || f.presence !== IMPLICIT4) {
        continue;
      }
    }
    const jsonValue = fieldToJson(f, msg.get(f), opts);
    if (jsonValue !== undefined) {
      json[jsonName(f, opts)] = jsonValue;
    }
  }
  if (opts.registry) {
    const tagSeen = new Set;
    for (const { no } of (_a = msg.getUnknown()) !== null && _a !== undefined ? _a : []) {
      if (!tagSeen.has(no)) {
        tagSeen.add(no);
        const extension = opts.registry.getExtensionFor(msg.desc, no);
        if (!extension) {
          continue;
        }
        const value = getExtension(msg.message, extension);
        const [container, field] = createExtensionContainer(extension, value);
        const jsonValue = fieldToJson(field, container.get(field), opts);
        if (jsonValue !== undefined) {
          json[extension.jsonName] = jsonValue;
        }
      }
    }
  }
  return json;
}
function fieldToJson(f, val, opts) {
  switch (f.fieldKind) {
    case "scalar":
      return scalarToJson(f, val);
    case "message":
      return reflectToJson(val, opts);
    case "enum":
      return enumToJsonInternal(f.enum, val, opts.enumAsInteger);
    case "list":
      return listToJson(val, opts);
    case "map":
      return mapToJson(val, opts);
  }
}
function mapToJson(map, opts) {
  const f = map.field();
  const jsonObj = {};
  switch (f.mapKind) {
    case "scalar":
      for (const [entryKey, entryValue] of map) {
        jsonObj[entryKey] = scalarToJson(f, entryValue);
      }
      break;
    case "message":
      for (const [entryKey, entryValue] of map) {
        jsonObj[entryKey] = reflectToJson(entryValue, opts);
      }
      break;
    case "enum":
      for (const [entryKey, entryValue] of map) {
        jsonObj[entryKey] = enumToJsonInternal(f.enum, entryValue, opts.enumAsInteger);
      }
      break;
  }
  return opts.alwaysEmitImplicit || map.size > 0 ? jsonObj : undefined;
}
function listToJson(list, opts) {
  const f = list.field();
  const jsonArr = [];
  switch (f.listKind) {
    case "scalar":
      for (const item of list) {
        jsonArr.push(scalarToJson(f, item));
      }
      break;
    case "enum":
      for (const item of list) {
        jsonArr.push(enumToJsonInternal(f.enum, item, opts.enumAsInteger));
      }
      break;
    case "message":
      for (const item of list) {
        jsonArr.push(reflectToJson(item, opts));
      }
      break;
  }
  return opts.alwaysEmitImplicit || jsonArr.length > 0 ? jsonArr : undefined;
}
function enumToJsonInternal(desc, value, enumAsInteger) {
  var _a;
  if (typeof value != "number") {
    throw new Error(`cannot encode ${desc} to JSON: expected number, got ${formatVal(value)}`);
  }
  if (desc.typeName == "google.protobuf.NullValue") {
    return null;
  }
  if (enumAsInteger) {
    return value;
  }
  const val = desc.value[value];
  return (_a = val === null || val === undefined ? undefined : val.name) !== null && _a !== undefined ? _a : value;
}
function scalarToJson(field, value) {
  var _a, _b, _c, _d, _e, _f;
  switch (field.scalar) {
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
      if (typeof value != "number") {
        throw new Error(`cannot encode ${field} to JSON: ${(_a = checkField(field, value)) === null || _a === undefined ? undefined : _a.message}`);
      }
      return value;
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE:
      if (typeof value != "number") {
        throw new Error(`cannot encode ${field} to JSON: ${(_b = checkField(field, value)) === null || _b === undefined ? undefined : _b.message}`);
      }
      if (Number.isNaN(value))
        return "NaN";
      if (value === Number.POSITIVE_INFINITY)
        return "Infinity";
      if (value === Number.NEGATIVE_INFINITY)
        return "-Infinity";
      return value;
    case ScalarType.STRING:
      if (typeof value != "string") {
        throw new Error(`cannot encode ${field} to JSON: ${(_c = checkField(field, value)) === null || _c === undefined ? undefined : _c.message}`);
      }
      return value;
    case ScalarType.BOOL:
      if (typeof value != "boolean") {
        throw new Error(`cannot encode ${field} to JSON: ${(_d = checkField(field, value)) === null || _d === undefined ? undefined : _d.message}`);
      }
      return value;
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
    case ScalarType.SINT64:
      if (typeof value != "bigint" && typeof value != "string") {
        throw new Error(`cannot encode ${field} to JSON: ${(_e = checkField(field, value)) === null || _e === undefined ? undefined : _e.message}`);
      }
      return value.toString();
    case ScalarType.BYTES:
      if (value instanceof Uint8Array) {
        return base64Encode(value);
      }
      throw new Error(`cannot encode ${field} to JSON: ${(_f = checkField(field, value)) === null || _f === undefined ? undefined : _f.message}`);
  }
}
function jsonName(f, opts) {
  return opts.useProtoFieldName ? f.name : f.jsonName;
}
function tryWktToJson(msg, opts) {
  if (!msg.desc.typeName.startsWith("google.protobuf.")) {
    return;
  }
  switch (msg.desc.typeName) {
    case "google.protobuf.Any":
      return anyToJson(msg.message, opts);
    case "google.protobuf.Timestamp":
      return timestampToJson(msg.message);
    case "google.protobuf.Duration":
      return durationToJson(msg.message);
    case "google.protobuf.FieldMask":
      return fieldMaskToJson(msg.message);
    case "google.protobuf.Struct":
      return structToJson(msg.message);
    case "google.protobuf.Value":
      return valueToJson(msg.message);
    case "google.protobuf.ListValue":
      return listValueToJson(msg.message);
    default:
      if (isWrapperDesc(msg.desc)) {
        const valueField = msg.desc.fields[0];
        return scalarToJson(valueField, msg.get(valueField));
      }
      return;
  }
}
function anyToJson(val, opts) {
  if (val.typeUrl === "") {
    return {};
  }
  const { registry } = opts;
  let message;
  let desc;
  if (registry) {
    message = anyUnpack(val, registry);
    if (message) {
      desc = registry.getMessage(message.$typeName);
    }
  }
  if (!desc || !message) {
    throw new Error(`cannot encode message ${val.$typeName} to JSON: "${val.typeUrl}" is not in the type registry`);
  }
  let json = reflectToJson(reflect(desc, message), opts);
  if (desc.typeName.startsWith("google.protobuf.") || json === null || Array.isArray(json) || typeof json !== "object") {
    json = { value: json };
  }
  json["@type"] = val.typeUrl;
  return json;
}
function durationToJson(val) {
  const seconds = Number(val.seconds);
  const nanos = val.nanos;
  if (seconds > 315576000000 || seconds < -315576000000) {
    throw new Error(`cannot encode message ${val.$typeName} to JSON: value out of range`);
  }
  if (seconds > 0 && nanos < 0 || seconds < 0 && nanos > 0) {
    throw new Error(`cannot encode message ${val.$typeName} to JSON: nanos sign must match seconds sign`);
  }
  let text = val.seconds.toString();
  if (nanos !== 0) {
    let nanosStr = Math.abs(nanos).toString();
    nanosStr = "0".repeat(9 - nanosStr.length) + nanosStr;
    if (nanosStr.substring(3) === "000000") {
      nanosStr = nanosStr.substring(0, 3);
    } else if (nanosStr.substring(6) === "000") {
      nanosStr = nanosStr.substring(0, 6);
    }
    text += "." + nanosStr;
    if (nanos < 0 && seconds == 0) {
      text = "-" + text;
    }
  }
  return text + "s";
}
function fieldMaskToJson(val) {
  return val.paths.map((p) => {
    if (protoSnakeCase(protoCamelCase(p)) !== p) {
      throw new Error(`cannot encode message ${val.$typeName} to JSON: lowerCamelCase of path name "${p}" is irreversible`);
    }
    return protoCamelCase(p);
  }).join(",");
}
function structToJson(val) {
  const json = {};
  for (const [k, v] of Object.entries(val.fields)) {
    json[k] = valueToJson(v);
  }
  return json;
}
function valueToJson(val) {
  switch (val.kind.case) {
    case "nullValue":
      return null;
    case "numberValue":
      if (!Number.isFinite(val.kind.value)) {
        throw new Error(`${val.$typeName} cannot be NaN or Infinity`);
      }
      return val.kind.value;
    case "boolValue":
      return val.kind.value;
    case "stringValue":
      return val.kind.value;
    case "structValue":
      return structToJson(val.kind.value);
    case "listValue":
      return listValueToJson(val.kind.value);
    default:
      throw new Error(`${val.$typeName} must have a value`);
  }
}
function listValueToJson(val) {
  return val.values.map(valueToJson);
}
function timestampToJson(val) {
  const ms = Number(val.seconds) * 1000;
  if (ms < Date.parse("0001-01-01T00:00:00Z") || ms > Date.parse("9999-12-31T23:59:59Z")) {
    throw new Error(`cannot encode message ${val.$typeName} to JSON: must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive`);
  }
  if (val.nanos < 0) {
    throw new Error(`cannot encode message ${val.$typeName} to JSON: nanos must not be negative`);
  }
  if (val.nanos > 999999999) {
    throw new Error(`cannot encode message ${val.$typeName} to JSON: nanos must not be greater than 99999999`);
  }
  let z = "Z";
  if (val.nanos > 0) {
    const nanosStr = (val.nanos + 1e9).toString().substring(1);
    if (nanosStr.substring(3) === "000000") {
      z = "." + nanosStr.substring(0, 3) + "Z";
    } else if (nanosStr.substring(6) === "000") {
      z = "." + nanosStr.substring(0, 6) + "Z";
    } else {
      z = "." + nanosStr + "Z";
    }
  }
  return new Date(ms).toISOString().replace(".000Z", z);
}
// node_modules/@bufbuild/protobuf/dist/esm/from-json.js
var jsonReadDefaults = {
  ignoreUnknownFields: false
};
function makeReadOptions2(options) {
  return options ? Object.assign(Object.assign({}, jsonReadDefaults), options) : jsonReadDefaults;
}
function fromJson(schema, json, options) {
  const msg = reflect(schema);
  try {
    readMessage2(msg, json, makeReadOptions2(options));
  } catch (e) {
    if (isFieldError(e)) {
      throw new Error(`cannot decode ${e.field()} from JSON: ${e.message}`, {
        cause: e
      });
    }
    throw e;
  }
  return msg.message;
}
var messageJsonFields = new WeakMap;
function getJsonField(desc, jsonKey) {
  var _a;
  if (!messageJsonFields.has(desc)) {
    const jsonNames = new Map;
    for (const field of desc.fields) {
      jsonNames.set(field.name, field).set(field.jsonName, field);
    }
    messageJsonFields.set(desc, jsonNames);
  }
  return (_a = messageJsonFields.get(desc)) === null || _a === undefined ? undefined : _a.get(jsonKey);
}
function readMessage2(msg, json, opts) {
  var _a;
  if (tryWktFromJson(msg, json, opts)) {
    return;
  }
  if (json == null || Array.isArray(json) || typeof json != "object") {
    throw new Error(`cannot decode ${msg.desc} from JSON: ${formatVal(json)}`);
  }
  const oneofSeen = new Map;
  for (const [jsonKey, jsonValue] of Object.entries(json)) {
    const field = getJsonField(msg.desc, jsonKey);
    if (field) {
      if (field.oneof) {
        if (jsonValue === null && field.fieldKind == "scalar") {
          continue;
        }
        const seen = oneofSeen.get(field.oneof);
        if (seen !== undefined) {
          throw new FieldError(field.oneof, `oneof set multiple times by ${seen.name} and ${field.name}`);
        }
        oneofSeen.set(field.oneof, field);
      }
      readField2(msg, field, jsonValue, opts);
    } else {
      let extension = undefined;
      if (jsonKey.startsWith("[") && jsonKey.endsWith("]") && (extension = (_a = opts.registry) === null || _a === undefined ? undefined : _a.getExtension(jsonKey.substring(1, jsonKey.length - 1))) && extension.extendee.typeName === msg.desc.typeName) {
        const [container, field2, get] = createExtensionContainer(extension);
        readField2(container, field2, jsonValue, opts);
        setExtension(msg.message, extension, get());
      }
      if (!extension && !opts.ignoreUnknownFields) {
        throw new Error(`cannot decode ${msg.desc} from JSON: key "${jsonKey}" is unknown`);
      }
    }
  }
}
function readField2(msg, field, json, opts) {
  switch (field.fieldKind) {
    case "scalar":
      readScalarField(msg, field, json);
      break;
    case "enum":
      readEnumField(msg, field, json, opts);
      break;
    case "message":
      readMessageField2(msg, field, json, opts);
      break;
    case "list":
      readListField2(msg.get(field), json, opts);
      break;
    case "map":
      readMapField(msg.get(field), json, opts);
      break;
  }
}
function readListOrMapItem(field, json, opts) {
  if (field.scalar && json !== null) {
    return scalarFromJson(field, json);
  }
  if (field.message && !isResetSentinelNullValue(field, json)) {
    const msgValue = reflect(field.message);
    readMessage2(msgValue, json, opts);
    return msgValue;
  }
  if (field.enum && !isResetSentinelNullValue(field, json)) {
    return readEnum(field.enum, json, opts.ignoreUnknownFields);
  }
  throw new FieldError(field, `${field.fieldKind === "list" ? "list item" : "map value"} must not be null`);
}
function readMapField(map, json, opts) {
  if (json === null) {
    return;
  }
  const field = map.field();
  if (typeof json != "object" || Array.isArray(json)) {
    throw new FieldError(field, "expected object, got " + formatVal(json));
  }
  for (const [jsonMapKey, jsonMapValue] of Object.entries(json)) {
    const key = mapKeyFromJson(field.mapKey, jsonMapKey);
    const value = readListOrMapItem(field, jsonMapValue, opts);
    if (value !== tokenIgnoredUnknownEnum) {
      map.set(key, value);
    }
  }
}
function readListField2(list, json, opts) {
  if (json === null) {
    return;
  }
  const field = list.field();
  if (!Array.isArray(json)) {
    throw new FieldError(field, "expected Array, got " + formatVal(json));
  }
  for (const jsonItem of json) {
    const value = readListOrMapItem(field, jsonItem, opts);
    if (value !== tokenIgnoredUnknownEnum) {
      list.add(value);
    }
  }
}
function readMessageField2(msg, field, json, opts) {
  if (isResetSentinelNullValue(field, json)) {
    msg.clear(field);
    return;
  }
  const msgValue = msg.isSet(field) ? msg.get(field) : reflect(field.message);
  readMessage2(msgValue, json, opts);
  msg.set(field, msgValue);
}
function readEnumField(msg, field, json, opts) {
  if (isResetSentinelNullValue(field, json)) {
    msg.clear(field);
    return;
  }
  const enumValue = readEnum(field.enum, json, opts.ignoreUnknownFields);
  if (enumValue !== tokenIgnoredUnknownEnum) {
    msg.set(field, enumValue);
  }
}
function readScalarField(msg, field, json) {
  if (json === null) {
    msg.clear(field);
  } else {
    msg.set(field, scalarFromJson(field, json));
  }
}
function isResetSentinelNullValue(field, json) {
  var _a, _b;
  return json === null && ((_a = field.message) === null || _a === undefined ? undefined : _a.typeName) != "google.protobuf.Value" && ((_b = field.enum) === null || _b === undefined ? undefined : _b.typeName) != "google.protobuf.NullValue";
}
var tokenIgnoredUnknownEnum = Symbol();
function readEnum(desc, json, ignoreUnknownFields) {
  if (json === null) {
    return desc.values[0].number;
  }
  switch (typeof json) {
    case "number":
      if (Number.isInteger(json)) {
        return json;
      }
      break;
    case "string":
      const value = desc.values.find((ev) => ev.name === json);
      if (value !== undefined) {
        return value.number;
      }
      if (ignoreUnknownFields) {
        return tokenIgnoredUnknownEnum;
      }
      break;
  }
  throw new Error(`cannot decode ${desc} from JSON: ${formatVal(json)}`);
}
function scalarFromJson(field, json) {
  switch (field.scalar) {
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      if (json === "NaN")
        return NaN;
      if (json === "Infinity")
        return Number.POSITIVE_INFINITY;
      if (json === "-Infinity")
        return Number.NEGATIVE_INFINITY;
      if (typeof json == "number") {
        if (Number.isNaN(json)) {
          throw new FieldError(field, "unexpected NaN number");
        }
        if (!Number.isFinite(json)) {
          throw new FieldError(field, "unexpected infinite number");
        }
        break;
      }
      if (typeof json == "string") {
        if (json === "") {
          break;
        }
        if (json.trim().length !== json.length) {
          break;
        }
        const float = Number(json);
        if (!Number.isFinite(float)) {
          break;
        }
        return float;
      }
      break;
    case ScalarType.INT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
    case ScalarType.UINT32:
      return int32FromJson(json);
    case ScalarType.BYTES:
      if (typeof json == "string") {
        if (json === "") {
          return new Uint8Array(0);
        }
        try {
          return base64Decode(json);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw new FieldError(field, message);
        }
      }
      break;
  }
  return json;
}
function mapKeyFromJson(type, jsonString) {
  switch (type) {
    case ScalarType.BOOL:
      switch (jsonString) {
        case "true":
          return true;
        case "false":
          return false;
      }
      return jsonString;
    case ScalarType.INT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT32:
    case ScalarType.SFIXED32:
    case ScalarType.SINT32:
      return int32FromJson(jsonString);
    default:
      return jsonString;
  }
}
function int32FromJson(json) {
  if (typeof json == "string") {
    if (json === "") {
      return json;
    }
    if (json.trim().length !== json.length) {
      return json;
    }
    const num = Number(json);
    if (Number.isNaN(num)) {
      return json;
    }
    return num;
  }
  return json;
}
function tryWktFromJson(msg, jsonValue, opts) {
  if (!msg.desc.typeName.startsWith("google.protobuf.")) {
    return false;
  }
  switch (msg.desc.typeName) {
    case "google.protobuf.Any":
      anyFromJson(msg.message, jsonValue, opts);
      return true;
    case "google.protobuf.Timestamp":
      timestampFromJson(msg.message, jsonValue);
      return true;
    case "google.protobuf.Duration":
      durationFromJson(msg.message, jsonValue);
      return true;
    case "google.protobuf.FieldMask":
      fieldMaskFromJson(msg.message, jsonValue);
      return true;
    case "google.protobuf.Struct":
      structFromJson(msg.message, jsonValue);
      return true;
    case "google.protobuf.Value":
      valueFromJson(msg.message, jsonValue);
      return true;
    case "google.protobuf.ListValue":
      listValueFromJson(msg.message, jsonValue);
      return true;
    default:
      if (isWrapperDesc(msg.desc)) {
        const valueField = msg.desc.fields[0];
        if (jsonValue === null) {
          msg.clear(valueField);
        } else {
          msg.set(valueField, scalarFromJson(valueField, jsonValue));
        }
        return true;
      }
      return false;
  }
}
function anyFromJson(any, json, opts) {
  var _a;
  if (json === null || Array.isArray(json) || typeof json != "object") {
    throw new Error(`cannot decode message ${any.$typeName} from JSON: expected object but got ${formatVal(json)}`);
  }
  if (Object.keys(json).length == 0) {
    return;
  }
  const typeUrl = json["@type"];
  if (typeof typeUrl != "string" || typeUrl == "") {
    throw new Error(`cannot decode message ${any.$typeName} from JSON: "@type" is empty`);
  }
  const typeName = typeUrl.includes("/") ? typeUrl.substring(typeUrl.lastIndexOf("/") + 1) : typeUrl;
  if (!typeName.length) {
    throw new Error(`cannot decode message ${any.$typeName} from JSON: "@type" is invalid`);
  }
  const desc = (_a = opts.registry) === null || _a === undefined ? undefined : _a.getMessage(typeName);
  if (!desc) {
    throw new Error(`cannot decode message ${any.$typeName} from JSON: ${typeUrl} is not in the type registry`);
  }
  const msg = reflect(desc);
  if (typeName.startsWith("google.protobuf.") && Object.prototype.hasOwnProperty.call(json, "value")) {
    const value = json.value;
    readMessage2(msg, value, opts);
  } else {
    const copy = Object.assign({}, json);
    delete copy["@type"];
    readMessage2(msg, copy, opts);
  }
  anyPack(msg.desc, msg.message, any);
}
function timestampFromJson(timestamp, json) {
  if (typeof json !== "string") {
    throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: ${formatVal(json)}`);
  }
  const matches = json.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-][0-9][0-9]:[0-9][0-9]))$/);
  if (!matches) {
    throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: invalid RFC 3339 string`);
  }
  const ms = Date.parse(matches[1] + "-" + matches[2] + "-" + matches[3] + "T" + matches[4] + ":" + matches[5] + ":" + matches[6] + (matches[8] ? matches[8] : "Z"));
  if (Number.isNaN(ms)) {
    throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: invalid RFC 3339 string`);
  }
  if (ms < Date.parse("0001-01-01T00:00:00Z") || ms > Date.parse("9999-12-31T23:59:59Z")) {
    throw new Error(`cannot decode message ${timestamp.$typeName} from JSON: must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive`);
  }
  timestamp.seconds = protoInt64.parse(ms / 1000);
  timestamp.nanos = 0;
  if (matches[7]) {
    timestamp.nanos = parseInt("1" + matches[7] + "0".repeat(9 - matches[7].length)) - 1e9;
  }
}
function durationFromJson(duration, json) {
  if (typeof json !== "string") {
    throw new Error(`cannot decode message ${duration.$typeName} from JSON: ${formatVal(json)}`);
  }
  const match = json.match(/^(-?[0-9]+)(?:\.([0-9]+))?s/);
  if (match === null) {
    throw new Error(`cannot decode message ${duration.$typeName} from JSON: ${formatVal(json)}`);
  }
  const longSeconds = Number(match[1]);
  if (longSeconds > 315576000000 || longSeconds < -315576000000) {
    throw new Error(`cannot decode message ${duration.$typeName} from JSON: ${formatVal(json)}`);
  }
  duration.seconds = protoInt64.parse(longSeconds);
  if (typeof match[2] !== "string") {
    return;
  }
  const nanosStr = match[2] + "0".repeat(9 - match[2].length);
  duration.nanos = parseInt(nanosStr);
  if (longSeconds < 0 || Object.is(longSeconds, -0)) {
    duration.nanos = -duration.nanos;
  }
}
function fieldMaskFromJson(fieldMask, json) {
  if (typeof json !== "string") {
    throw new Error(`cannot decode message ${fieldMask.$typeName} from JSON: ${formatVal(json)}`);
  }
  if (json === "") {
    return;
  }
  fieldMask.paths = json.split(",").map((path) => {
    if (path.includes("_")) {
      throw new Error(`cannot decode message ${fieldMask.$typeName} from JSON: path names must be lowerCamelCase`);
    }
    return protoSnakeCase(path);
  });
}
function structFromJson(struct, json) {
  if (typeof json != "object" || json == null || Array.isArray(json)) {
    throw new Error(`cannot decode message ${struct.$typeName} from JSON ${formatVal(json)}`);
  }
  for (const [k, v] of Object.entries(json)) {
    const parsedV = create(ValueSchema);
    valueFromJson(parsedV, v);
    struct.fields[k] = parsedV;
  }
}
function valueFromJson(value, json) {
  switch (typeof json) {
    case "number":
      value.kind = { case: "numberValue", value: json };
      break;
    case "string":
      value.kind = { case: "stringValue", value: json };
      break;
    case "boolean":
      value.kind = { case: "boolValue", value: json };
      break;
    case "object":
      if (json === null) {
        value.kind = { case: "nullValue", value: NullValue.NULL_VALUE };
      } else if (Array.isArray(json)) {
        const listValue = create(ListValueSchema);
        listValueFromJson(listValue, json);
        value.kind = { case: "listValue", value: listValue };
      } else {
        const struct = create(StructSchema);
        structFromJson(struct, json);
        value.kind = { case: "structValue", value: struct };
      }
      break;
    default:
      throw new Error(`cannot decode message ${value.$typeName} from JSON ${formatVal(json)}`);
  }
  return value;
}
function listValueFromJson(listValue, json) {
  if (!Array.isArray(json)) {
    throw new Error(`cannot decode message ${listValue.$typeName} from JSON ${formatVal(json)}`);
  }
  for (const e of json) {
    const value = create(ValueSchema);
    valueFromJson(value, e);
    listValue.values.push(value);
  }
}
// proto/agent_pb.ts
var file_agent = /* @__PURE__ */ fileDesc("CgthZ2VudC5wcm90bxIIYWdlbnQudjEicgoOR2xvYlRvb2xSZXN1bHQSLAoHc3VjY2VzcxgBIAEoCzIZLmFnZW50LnYxLkdsb2JUb29sU3VjY2Vzc0gAEigKBWVycm9yGAIgASgLMhcuYWdlbnQudjEuR2xvYlRvb2xFcnJvckgAQggKBnJlc3VsdCIeCg1HbG9iVG9vbEVycm9yEg0KBWVycm9yGAEgASgJIokBCg9HbG9iVG9vbFN1Y2Nlc3MSDwoHcGF0dGVybhgBIAEoCRIMCgRwYXRoGAIgASgJEg0KBWZpbGVzGAMgAygJEhMKC3RvdGFsX2ZpbGVzGAQgASgFEhgKEGNsaWVudF90cnVuY2F0ZWQYBSABKAgSGQoRcmlwZ3JlcF90cnVuY2F0ZWQYBiABKAgiRgoMR2xvYlRvb2xDYWxsEgwKBGFyZ3MYASABKAwSKAoGcmVzdWx0GAIgASgLMhguYWdlbnQudjEuR2xvYlRvb2xSZXN1bHQibQoRUmVhZExpbnRzVG9vbENhbGwSKQoEYXJncxgBIAEoCzIbLmFnZW50LnYxLlJlYWRMaW50c1Rvb2xBcmdzEi0KBnJlc3VsdBgCIAEoCzIdLmFnZW50LnYxLlJlYWRMaW50c1Rvb2xSZXN1bHQiIgoRUmVhZExpbnRzVG9vbEFyZ3MSDQoFcGF0aHMYASADKAkigQEKE1JlYWRMaW50c1Rvb2xSZXN1bHQSMQoHc3VjY2VzcxgBIAEoCzIeLmFnZW50LnYxLlJlYWRMaW50c1Rvb2xTdWNjZXNzSAASLQoFZXJyb3IYAiABKAsyHC5hZ2VudC52MS5SZWFkTGludHNUb29sRXJyb3JIAEIICgZyZXN1bHQiewoUUmVhZExpbnRzVG9vbFN1Y2Nlc3MSMwoQZmlsZV9kaWFnbm9zdGljcxgBIAMoCzIZLmFnZW50LnYxLkZpbGVEaWFnbm9zdGljcxITCgt0b3RhbF9maWxlcxgCIAEoBRIZChF0b3RhbF9kaWFnbm9zdGljcxgDIAEoBSJpCg9GaWxlRGlhZ25vc3RpY3MSDAoEcGF0aBgBIAEoCRItCgtkaWFnbm9zdGljcxgCIAMoCzIYLmFnZW50LnYxLkRpYWdub3N0aWNJdGVtEhkKEWRpYWdub3N0aWNzX2NvdW50GAMgASgFIqsBCg5EaWFnbm9zdGljSXRlbRIuCghzZXZlcml0eRgBIAEoDjIcLmFnZW50LnYxLkRpYWdub3N0aWNTZXZlcml0eRIoCgVyYW5nZRgCIAEoCzIZLmFnZW50LnYxLkRpYWdub3N0aWNSYW5nZRIPCgdtZXNzYWdlGAMgASgJEg4KBnNvdXJjZRgEIAEoCRIMCgRjb2RlGAUgASgJEhAKCGlzX3N0YWxlGAYgASgIIlUKD0RpYWdub3N0aWNSYW5nZRIhCgVzdGFydBgBIAEoCzISLmFnZW50LnYxLlBvc2l0aW9uEh8KA2VuZBgCIAEoCzISLmFnZW50LnYxLlBvc2l0aW9uIisKElJlYWRMaW50c1Rvb2xFcnJvchIVCg1lcnJvcl9tZXNzYWdlGAEgASgJIh0KDE1jcFRvb2xFcnJvchINCgVlcnJvchgBIAEoCSLSAQoNTWNwVG9vbFJlc3VsdBInCgdzdWNjZXNzGAEgASgLMhQuYWdlbnQudjEuTWNwU3VjY2Vzc0gAEicKBWVycm9yGAIgASgLMhYuYWdlbnQudjEuTWNwVG9vbEVycm9ySAASKQoIcmVqZWN0ZWQYAyABKAsyFS5hZ2VudC52MS5NY3BSZWplY3RlZEgAEjoKEXBlcm1pc3Npb25fZGVuaWVkGAQgASgLMh0uYWdlbnQudjEuTWNwUGVybWlzc2lvbkRlbmllZEgAQggKBnJlc3VsdCJXCgtNY3BUb29sQ2FsbBIfCgRhcmdzGAEgASgLMhEuYWdlbnQudjEuTWNwQXJncxInCgZyZXN1bHQYAiABKAsyFy5hZ2VudC52MS5NY3BUb29sUmVzdWx0Im0KEVNlbVNlYXJjaFRvb2xDYWxsEikKBGFyZ3MYASABKAsyGy5hZ2VudC52MS5TZW1TZWFyY2hUb29sQXJncxItCgZyZXN1bHQYAiABKAsyHS5hZ2VudC52MS5TZW1TZWFyY2hUb29sUmVzdWx0IlMKEVNlbVNlYXJjaFRvb2xBcmdzEg0KBXF1ZXJ5GAEgASgJEhoKEnRhcmdldF9kaXJlY3RvcmllcxgCIAMoCRITCgtleHBsYW5hdGlvbhgDIAEoCSKBAQoTU2VtU2VhcmNoVG9vbFJlc3VsdBIxCgdzdWNjZXNzGAEgASgLMh4uYWdlbnQudjEuU2VtU2VhcmNoVG9vbFN1Y2Nlc3NIABItCgVlcnJvchgCIAEoCzIcLmFnZW50LnYxLlNlbVNlYXJjaFRvb2xFcnJvckgAQggKBnJlc3VsdCI9ChRTZW1TZWFyY2hUb29sU3VjY2VzcxIPCgdyZXN1bHRzGAEgASgJEhQKDGNvZGVfcmVzdWx0cxgCIAMoDCIrChJTZW1TZWFyY2hUb29sRXJyb3ISFQoNZXJyb3JfbWVzc2FnZRgBIAEoCSKCAQoYTGlzdE1jcFJlc291cmNlc1Rvb2xDYWxsEjAKBGFyZ3MYASABKAsyIi5hZ2VudC52MS5MaXN0TWNwUmVzb3VyY2VzRXhlY0FyZ3MSNAoGcmVzdWx0GAIgASgLMiQuYWdlbnQudjEuTGlzdE1jcFJlc291cmNlc0V4ZWNSZXN1bHQifwoXUmVhZE1jcFJlc291cmNlVG9vbENhbGwSLwoEYXJncxgBIAEoCzIhLmFnZW50LnYxLlJlYWRNY3BSZXNvdXJjZUV4ZWNBcmdzEjMKBnJlc3VsdBgCIAEoCzIjLmFnZW50LnYxLlJlYWRNY3BSZXNvdXJjZUV4ZWNSZXN1bHQiWQoNRmV0Y2hUb29sQ2FsbBIhCgRhcmdzGAEgASgLMhMuYWdlbnQudjEuRmV0Y2hBcmdzEiUKBnJlc3VsdBgCIAEoCzIVLmFnZW50LnYxLkZldGNoUmVzdWx0Im4KFFJlY29yZFNjcmVlblRvb2xDYWxsEigKBGFyZ3MYASABKAsyGi5hZ2VudC52MS5SZWNvcmRTY3JlZW5BcmdzEiwKBnJlc3VsdBgCIAEoCzIcLmFnZW50LnYxLlJlY29yZFNjcmVlblJlc3VsdCJ3ChdXcml0ZVNoZWxsU3RkaW5Ub29sQ2FsbBIrCgRhcmdzGAEgASgLMh0uYWdlbnQudjEuV3JpdGVTaGVsbFN0ZGluQXJncxIvCgZyZXN1bHQYAiABKAsyHy5hZ2VudC52MS5Xcml0ZVNoZWxsU3RkaW5SZXN1bHQisQEKC1JlZmxlY3RBcmdzEiIKGnVuZXhwZWN0ZWRfYWN0aW9uX291dGNvbWVzGAEgASgJEh0KFXJlbGV2YW50X2luc3RydWN0aW9ucxgCIAEoCRIZChFzY2VuYXJpb19hbmFseXNpcxgDIAEoCRIaChJjcml0aWNhbF9zeW50aGVzaXMYBCABKAkSEgoKbmV4dF9zdGVwcxgFIAEoCRIUCgx0b29sX2NhbGxfaWQYBiABKAkibwoNUmVmbGVjdFJlc3VsdBIrCgdzdWNjZXNzGAEgASgLMhguYWdlbnQudjEuUmVmbGVjdFN1Y2Nlc3NIABInCgVlcnJvchgCIAEoCzIWLmFnZW50LnYxLlJlZmxlY3RFcnJvckgAQggKBnJlc3VsdCIQCg5SZWZsZWN0U3VjY2VzcyIdCgxSZWZsZWN0RXJyb3ISDQoFZXJyb3IYASABKAkiXwoPUmVmbGVjdFRvb2xDYWxsEiMKBGFyZ3MYASABKAsyFS5hZ2VudC52MS5SZWZsZWN0QXJncxInCgZyZXN1bHQYAiABKAsyFy5hZ2VudC52MS5SZWZsZWN0UmVzdWx0IlkKF1N0YXJ0R3JpbmRFeGVjdXRpb25BcmdzEhgKC2V4cGxhbmF0aW9uGAEgASgJSACIAQESFAoMdG9vbF9jYWxsX2lkGAIgASgJQg4KDF9leHBsYW5hdGlvbiKTAQoZU3RhcnRHcmluZEV4ZWN1dGlvblJlc3VsdBI3CgdzdWNjZXNzGAEgASgLMiQuYWdlbnQudjEuU3RhcnRHcmluZEV4ZWN1dGlvblN1Y2Nlc3NIABIzCgVlcnJvchgCIAEoCzIiLmFnZW50LnYxLlN0YXJ0R3JpbmRFeGVjdXRpb25FcnJvckgAQggKBnJlc3VsdCIcChpTdGFydEdyaW5kRXhlY3V0aW9uU3VjY2VzcyIpChhTdGFydEdyaW5kRXhlY3V0aW9uRXJyb3ISDQoFZXJyb3IYASABKAkigwEKG1N0YXJ0R3JpbmRFeGVjdXRpb25Ub29sQ2FsbBIvCgRhcmdzGAEgASgLMiEuYWdlbnQudjEuU3RhcnRHcmluZEV4ZWN1dGlvbkFyZ3MSMwoGcmVzdWx0GAIgASgLMiMuYWdlbnQudjEuU3RhcnRHcmluZEV4ZWN1dGlvblJlc3VsdCJYChZTdGFydEdyaW5kUGxhbm5pbmdBcmdzEhgKC2V4cGxhbmF0aW9uGAEgASgJSACIAQESFAoMdG9vbF9jYWxsX2lkGAIgASgJQg4KDF9leHBsYW5hdGlvbiKQAQoYU3RhcnRHcmluZFBsYW5uaW5nUmVzdWx0EjYKB3N1Y2Nlc3MYASABKAsyIy5hZ2VudC52MS5TdGFydEdyaW5kUGxhbm5pbmdTdWNjZXNzSAASMgoFZXJyb3IYAiABKAsyIS5hZ2VudC52MS5TdGFydEdyaW5kUGxhbm5pbmdFcnJvckgAQggKBnJlc3VsdCIbChlTdGFydEdyaW5kUGxhbm5pbmdTdWNjZXNzIigKF1N0YXJ0R3JpbmRQbGFubmluZ0Vycm9yEg0KBWVycm9yGAEgASgJIoABChpTdGFydEdyaW5kUGxhbm5pbmdUb29sQ2FsbBIuCgRhcmdzGAEgASgLMiAuYWdlbnQudjEuU3RhcnRHcmluZFBsYW5uaW5nQXJncxIyCgZyZXN1bHQYAiABKAsyIi5hZ2VudC52MS5TdGFydEdyaW5kUGxhbm5pbmdSZXN1bHQinAEKCFRhc2tBcmdzEhMKC2Rlc2NyaXB0aW9uGAEgASgJEg4KBnByb21wdBgCIAEoCRItCg1zdWJhZ2VudF90eXBlGAMgASgLMhYuYWdlbnQudjEuU3ViYWdlbnRUeXBlEhIKBW1vZGVsGAQgASgJSACIAQESEwoGcmVzdW1lGAUgASgJSAGIAQFCCAoGX21vZGVsQgkKB19yZXN1bWUiqgEKC1Rhc2tTdWNjZXNzEjYKEmNvbnZlcnNhdGlvbl9zdGVwcxgBIAMoCzIaLmFnZW50LnYxLkNvbnZlcnNhdGlvblN0ZXASFQoIYWdlbnRfaWQYAiABKAlIAIgBARIVCg1pc19iYWNrZ3JvdW5kGAMgASgIEhgKC2R1cmF0aW9uX21zGAQgASgESAGIAQFCCwoJX2FnZW50X2lkQg4KDF9kdXJhdGlvbl9tcyIaCglUYXNrRXJyb3ISDQoFZXJyb3IYASABKAkiZgoKVGFza1Jlc3VsdBIoCgdzdWNjZXNzGAEgASgLMhUuYWdlbnQudjEuVGFza1N1Y2Nlc3NIABIkCgVlcnJvchgCIAEoCzITLmFnZW50LnYxLlRhc2tFcnJvckgAQggKBnJlc3VsdCJWCgxUYXNrVG9vbENhbGwSIAoEYXJncxgBIAEoCzISLmFnZW50LnYxLlRhc2tBcmdzEiQKBnJlc3VsdBgCIAEoCzIULmFnZW50LnYxLlRhc2tSZXN1bHQiTAoRVGFza1Rvb2xDYWxsRGVsdGESNwoSaW50ZXJhY3Rpb25fdXBkYXRlGAEgASgLMhsuYWdlbnQudjEuSW50ZXJhY3Rpb25VcGRhdGUiyw8KCFRvb2xDYWxsEjIKD3NoZWxsX3Rvb2xfY2FsbBgBIAEoCzIXLmFnZW50LnYxLlNoZWxsVG9vbENhbGxIABI0ChBkZWxldGVfdG9vbF9jYWxsGAMgASgLMhguYWdlbnQudjEuRGVsZXRlVG9vbENhbGxIABIwCg5nbG9iX3Rvb2xfY2FsbBgEIAEoCzIWLmFnZW50LnYxLkdsb2JUb29sQ2FsbEgAEjAKDmdyZXBfdG9vbF9jYWxsGAUgASgLMhYuYWdlbnQudjEuR3JlcFRvb2xDYWxsSAASMAoOcmVhZF90b29sX2NhbGwYCCABKAsyFi5hZ2VudC52MS5SZWFkVG9vbENhbGxIABI/ChZ1cGRhdGVfdG9kb3NfdG9vbF9jYWxsGAkgASgLMh0uYWdlbnQudjEuVXBkYXRlVG9kb3NUb29sQ2FsbEgAEjsKFHJlYWRfdG9kb3NfdG9vbF9jYWxsGAogASgLMhsuYWdlbnQudjEuUmVhZFRvZG9zVG9vbENhbGxIABIwCg5lZGl0X3Rvb2xfY2FsbBgMIAEoCzIWLmFnZW50LnYxLkVkaXRUb29sQ2FsbEgAEiwKDGxzX3Rvb2xfY2FsbBgNIAEoCzIULmFnZW50LnYxLkxzVG9vbENhbGxIABI7ChRyZWFkX2xpbnRzX3Rvb2xfY2FsbBgOIAEoCzIbLmFnZW50LnYxLlJlYWRMaW50c1Rvb2xDYWxsSAASLgoNbWNwX3Rvb2xfY2FsbBgPIAEoCzIVLmFnZW50LnYxLk1jcFRvb2xDYWxsSAASOwoUc2VtX3NlYXJjaF90b29sX2NhbGwYECABKAsyGy5hZ2VudC52MS5TZW1TZWFyY2hUb29sQ2FsbEgAEj0KFWNyZWF0ZV9wbGFuX3Rvb2xfY2FsbBgRIAEoCzIcLmFnZW50LnYxLkNyZWF0ZVBsYW5Ub29sQ2FsbEgAEjsKFHdlYl9zZWFyY2hfdG9vbF9jYWxsGBIgASgLMhsuYWdlbnQudjEuV2ViU2VhcmNoVG9vbENhbGxIABIwCg50YXNrX3Rvb2xfY2FsbBgTIAEoCzIWLmFnZW50LnYxLlRhc2tUb29sQ2FsbEgAEkoKHGxpc3RfbWNwX3Jlc291cmNlc190b29sX2NhbGwYFCABKAsyIi5hZ2VudC52MS5MaXN0TWNwUmVzb3VyY2VzVG9vbENhbGxIABJIChtyZWFkX21jcF9yZXNvdXJjZV90b29sX2NhbGwYFSABKAsyIS5hZ2VudC52MS5SZWFkTWNwUmVzb3VyY2VUb29sQ2FsbEgAEkYKGmFwcGx5X2FnZW50X2RpZmZfdG9vbF9jYWxsGBYgASgLMiAuYWdlbnQudjEuQXBwbHlBZ2VudERpZmZUb29sQ2FsbEgAEj8KFmFza19xdWVzdGlvbl90b29sX2NhbGwYFyABKAsyHS5hZ2VudC52MS5Bc2tRdWVzdGlvblRvb2xDYWxsSAASMgoPZmV0Y2hfdG9vbF9jYWxsGBggASgLMhcuYWdlbnQudjEuRmV0Y2hUb29sQ2FsbEgAEj0KFXN3aXRjaF9tb2RlX3Rvb2xfY2FsbBgZIAEoCzIcLmFnZW50LnYxLlN3aXRjaE1vZGVUb29sQ2FsbEgAEjsKFGV4YV9zZWFyY2hfdG9vbF9jYWxsGBogASgLMhsuYWdlbnQudjEuRXhhU2VhcmNoVG9vbENhbGxIABI5ChNleGFfZmV0Y2hfdG9vbF9jYWxsGBsgASgLMhouYWdlbnQudjEuRXhhRmV0Y2hUb29sQ2FsbEgAEkMKGGdlbmVyYXRlX2ltYWdlX3Rvb2xfY2FsbBgcIAEoCzIfLmFnZW50LnYxLkdlbmVyYXRlSW1hZ2VUb29sQ2FsbEgAEkEKF3JlY29yZF9zY3JlZW5fdG9vbF9jYWxsGB0gASgLMh4uYWdlbnQudjEuUmVjb3JkU2NyZWVuVG9vbENhbGxIABI/ChZjb21wdXRlcl91c2VfdG9vbF9jYWxsGB4gASgLMh0uYWdlbnQudjEuQ29tcHV0ZXJVc2VUb29sQ2FsbEgAEkgKG3dyaXRlX3NoZWxsX3N0ZGluX3Rvb2xfY2FsbBgfIAEoCzIhLmFnZW50LnYxLldyaXRlU2hlbGxTdGRpblRvb2xDYWxsSAASNgoRcmVmbGVjdF90b29sX2NhbGwYICABKAsyGS5hZ2VudC52MS5SZWZsZWN0VG9vbENhbGxIABJOCh5zZXR1cF92bV9lbnZpcm9ubWVudF90b29sX2NhbGwYISABKAsyJC5hZ2VudC52MS5TZXR1cFZtRW52aXJvbm1lbnRUb29sQ2FsbEgAEjoKE3RydW5jYXRlZF90b29sX2NhbGwYIiABKAsyGy5hZ2VudC52MS5UcnVuY2F0ZWRUb29sQ2FsbEgAElAKH3N0YXJ0X2dyaW5kX2V4ZWN1dGlvbl90b29sX2NhbGwYIyABKAsyJS5hZ2VudC52MS5TdGFydEdyaW5kRXhlY3V0aW9uVG9vbENhbGxIABJOCh5zdGFydF9ncmluZF9wbGFubmluZ190b29sX2NhbGwYJCABKAsyJC5hZ2VudC52MS5TdGFydEdyaW5kUGxhbm5pbmdUb29sQ2FsbEgAQgYKBHRvb2wiFwoVVHJ1bmNhdGVkVG9vbENhbGxBcmdzIhoKGFRydW5jYXRlZFRvb2xDYWxsU3VjY2VzcyInChZUcnVuY2F0ZWRUb29sQ2FsbEVycm9yEg0KBWVycm9yGAEgASgJIo0BChdUcnVuY2F0ZWRUb29sQ2FsbFJlc3VsdBI1CgdzdWNjZXNzGAEgASgLMiIuYWdlbnQudjEuVHJ1bmNhdGVkVG9vbENhbGxTdWNjZXNzSAASMQoFZXJyb3IYAiABKAsyIC5hZ2VudC52MS5UcnVuY2F0ZWRUb29sQ2FsbEVycm9ySABCCAoGcmVzdWx0IpQBChFUcnVuY2F0ZWRUb29sQ2FsbBIdChVvcmlnaW5hbF9zdGVwX2Jsb2JfaWQYASABKAwSLQoEYXJncxgCIAEoCzIfLmFnZW50LnYxLlRydW5jYXRlZFRvb2xDYWxsQXJncxIxCgZyZXN1bHQYAyABKAsyIS5hZ2VudC52MS5UcnVuY2F0ZWRUb29sQ2FsbFJlc3VsdCLRAQoNVG9vbENhbGxEZWx0YRI9ChVzaGVsbF90b29sX2NhbGxfZGVsdGEYASABKAsyHC5hZ2VudC52MS5TaGVsbFRvb2xDYWxsRGVsdGFIABI7ChR0YXNrX3Rvb2xfY2FsbF9kZWx0YRgCIAEoCzIbLmFnZW50LnYxLlRhc2tUb29sQ2FsbERlbHRhSAASOwoUZWRpdF90b29sX2NhbGxfZGVsdGEYAyABKAsyGy5hZ2VudC52MS5FZGl0VG9vbENhbGxEZWx0YUgAQgcKBWRlbHRhIrYBChBDb252ZXJzYXRpb25TdGVwEjcKEWFzc2lzdGFudF9tZXNzYWdlGAEgASgLMhouYWdlbnQudjEuQXNzaXN0YW50TWVzc2FnZUgAEicKCXRvb2xfY2FsbBgCIAEoCzISLmFnZW50LnYxLlRvb2xDYWxsSAASNQoQdGhpbmtpbmdfbWVzc2FnZRgDIAEoCzIZLmFnZW50LnYxLlRoaW5raW5nTWVzc2FnZUgAQgkKB21lc3NhZ2UigQQKEkNvbnZlcnNhdGlvbkFjdGlvbhI6ChN1c2VyX21lc3NhZ2VfYWN0aW9uGAEgASgLMhsuYWdlbnQudjEuVXNlck1lc3NhZ2VBY3Rpb25IABIvCg1yZXN1bWVfYWN0aW9uGAIgASgLMhYuYWdlbnQudjEuUmVzdW1lQWN0aW9uSAASLwoNY2FuY2VsX2FjdGlvbhgDIAEoCzIWLmFnZW50LnYxLkNhbmNlbEFjdGlvbkgAEjUKEHN1bW1hcml6ZV9hY3Rpb24YBCABKAsyGS5hZ2VudC52MS5TdW1tYXJpemVBY3Rpb25IABI8ChRzaGVsbF9jb21tYW5kX2FjdGlvbhgFIAEoCzIcLmFnZW50LnYxLlNoZWxsQ29tbWFuZEFjdGlvbkgAEjYKEXN0YXJ0X3BsYW5fYWN0aW9uGAYgASgLMhkuYWdlbnQudjEuU3RhcnRQbGFuQWN0aW9uSAASOgoTZXhlY3V0ZV9wbGFuX2FjdGlvbhgHIAEoCzIbLmFnZW50LnYxLkV4ZWN1dGVQbGFuQWN0aW9uSAASWgokYXN5bmNfYXNrX3F1ZXN0aW9uX2NvbXBsZXRpb25fYWN0aW9uGAggASgLMiouYWdlbnQudjEuQXN5bmNBc2tRdWVzdGlvbkNvbXBsZXRpb25BY3Rpb25IAEIICgZhY3Rpb24ivwEKEVVzZXJNZXNzYWdlQWN0aW9uEisKDHVzZXJfbWVzc2FnZRgBIAEoCzIVLmFnZW50LnYxLlVzZXJNZXNzYWdlEjEKD3JlcXVlc3RfY29udGV4dBgCIAEoCzIYLmFnZW50LnYxLlJlcXVlc3RDb250ZXh0EikKHHNlbmRfdG9faW50ZXJhY3Rpb25fbGlzdGVuZXIYAyABKAhIAIgBAUIfCh1fc2VuZF90b19pbnRlcmFjdGlvbl9saXN0ZW5lciIOCgxDYW5jZWxBY3Rpb24iQQoMUmVzdW1lQWN0aW9uEjEKD3JlcXVlc3RfY29udGV4dBgCIAEoCzIYLmFnZW50LnYxLlJlcXVlc3RDb250ZXh0IqABCiBBc3luY0Fza1F1ZXN0aW9uQ29tcGxldGlvbkFjdGlvbhIdChVvcmlnaW5hbF90b29sX2NhbGxfaWQYASABKAkSMAoNb3JpZ2luYWxfYXJncxgCIAEoCzIZLmFnZW50LnYxLkFza1F1ZXN0aW9uQXJncxIrCgZyZXN1bHQYAyABKAsyGy5hZ2VudC52MS5Bc2tRdWVzdGlvblJlc3VsdCIRCg9TdW1tYXJpemVBY3Rpb24iVAoSU2hlbGxDb21tYW5kQWN0aW9uEi0KDXNoZWxsX2NvbW1hbmQYASABKAsyFi5hZ2VudC52MS5TaGVsbENvbW1hbmQSDwoHZXhlY19pZBgCIAEoCSKCAQoPU3RhcnRQbGFuQWN0aW9uEisKDHVzZXJfbWVzc2FnZRgBIAEoCzIVLmFnZW50LnYxLlVzZXJNZXNzYWdlEjEKD3JlcXVlc3RfY29udGV4dBgCIAEoCzIYLmFnZW50LnYxLlJlcXVlc3RDb250ZXh0Eg8KB2lzX3NwZWMYAyABKAgi4gEKEUV4ZWN1dGVQbGFuQWN0aW9uEjEKD3JlcXVlc3RfY29udGV4dBgBIAEoCzIYLmFnZW50LnYxLlJlcXVlc3RDb250ZXh0Ei0KBHBsYW4YAiABKAsyGi5hZ2VudC52MS5Db252ZXJzYXRpb25QbGFuSACIAQESGgoNcGxhbl9maWxlX3VyaRgDIAEoCUgBiAEBEh4KEXBsYW5fZmlsZV9jb250ZW50GAQgASgJSAKIAQFCBwoFX3BsYW5CEAoOX3BsYW5fZmlsZV91cmlCFAoSX3BsYW5fZmlsZV9jb250ZW50IugCCgtVc2VyTWVzc2FnZRIMCgR0ZXh0GAEgASgJEhIKCm1lc3NhZ2VfaWQYAiABKAkSOAoQc2VsZWN0ZWRfY29udGV4dBgDIAEoCzIZLmFnZW50LnYxLlNlbGVjdGVkQ29udGV4dEgAiAEBEgwKBG1vZGUYBCABKAUSHQoQaXNfc2ltdWxhdGVkX21zZxgFIAEoCEgBiAEBEh8KEmJlc3Rfb2Zfbl9ncm91cF9pZBgGIAEoCUgCiAEBEigKG3RyeV91c2VfYmVzdF9vZl9uX3Byb21vdGlvbhgHIAEoCEgDiAEBEhYKCXJpY2hfdGV4dBgIIAEoCUgEiAEBQhMKEV9zZWxlY3RlZF9jb250ZXh0QhMKEV9pc19zaW11bGF0ZWRfbXNnQhUKE19iZXN0X29mX25fZ3JvdXBfaWRCHgocX3RyeV91c2VfYmVzdF9vZl9uX3Byb21vdGlvbkIMCgpfcmljaF90ZXh0IiAKEEFzc2lzdGFudE1lc3NhZ2USDAoEdGV4dBgBIAEoCSI0Cg9UaGlua2luZ01lc3NhZ2USDAoEdGV4dBgBIAEoCRITCgtkdXJhdGlvbl9tcxgCIAEoDSIfCgxTaGVsbENvbW1hbmQSDwoHY29tbWFuZBgBIAEoCSJACgtTaGVsbE91dHB1dBIOCgZzdGRvdXQYASABKAkSDgoGc3RkZXJyGAIgASgJEhEKCWV4aXRfY29kZRgDIAEoBSKiAQoQQ29udmVyc2F0aW9uVHVybhJCChdhZ2VudF9jb252ZXJzYXRpb25fdHVybhgBIAEoCzIfLmFnZW50LnYxLkFnZW50Q29udmVyc2F0aW9uVHVybkgAEkIKF3NoZWxsX2NvbnZlcnNhdGlvbl90dXJuGAIgASgLMh8uYWdlbnQudjEuU2hlbGxDb252ZXJzYXRpb25UdXJuSABCBgoEdHVybiIgChBDb252ZXJzYXRpb25QbGFuEgwKBHBsYW4YASABKAkivQEKGUNvbnZlcnNhdGlvblR1cm5TdHJ1Y3R1cmUSSwoXYWdlbnRfY29udmVyc2F0aW9uX3R1cm4YASABKAsyKC5hZ2VudC52MS5BZ2VudENvbnZlcnNhdGlvblR1cm5TdHJ1Y3R1cmVIABJLChdzaGVsbF9jb252ZXJzYXRpb25fdHVybhgCIAEoCzIoLmFnZW50LnYxLlNoZWxsQ29udmVyc2F0aW9uVHVyblN0cnVjdHVyZUgAQgYKBHR1cm4ilwEKFUFnZW50Q29udmVyc2F0aW9uVHVybhIrCgx1c2VyX21lc3NhZ2UYASABKAsyFS5hZ2VudC52MS5Vc2VyTWVzc2FnZRIpCgVzdGVwcxgCIAMoCzIaLmFnZW50LnYxLkNvbnZlcnNhdGlvblN0ZXASFwoKcmVxdWVzdF9pZBgDIAEoCUgAiAEBQg0KC19yZXF1ZXN0X2lkIm0KHkFnZW50Q29udmVyc2F0aW9uVHVyblN0cnVjdHVyZRIUCgx1c2VyX21lc3NhZ2UYASABKAwSDQoFc3RlcHMYAiADKAwSFwoKcmVxdWVzdF9pZBgDIAEoCUgAiAEBQg0KC19yZXF1ZXN0X2lkInMKFVNoZWxsQ29udmVyc2F0aW9uVHVybhItCg1zaGVsbF9jb21tYW5kGAEgASgLMhYuYWdlbnQudjEuU2hlbGxDb21tYW5kEisKDHNoZWxsX291dHB1dBgCIAEoCzIVLmFnZW50LnYxLlNoZWxsT3V0cHV0Ik0KHlNoZWxsQ29udmVyc2F0aW9uVHVyblN0cnVjdHVyZRIVCg1zaGVsbF9jb21tYW5kGAEgASgMEhQKDHNoZWxsX291dHB1dBgCIAEoDCImChNDb252ZXJzYXRpb25TdW1tYXJ5Eg8KB3N1bW1hcnkYASABKAkieAoaQ29udmVyc2F0aW9uU3VtbWFyeUFyY2hpdmUSGwoTc3VtbWFyaXplZF9tZXNzYWdlcxgBIAMoDBIPCgdzdW1tYXJ5GAIgASgJEhMKC3dpbmRvd190YWlsGAMgASgNEhcKD3N1bW1hcnlfbWVzc2FnZRgEIAEoDCJDChhDb252ZXJzYXRpb25Ub2tlbkRldGFpbHMSEwoLdXNlZF90b2tlbnMYASABKA0SEgoKbWF4X3Rva2VucxgCIAEoDSJfCglGaWxlU3RhdGUSFAoHY29udGVudBgBIAEoCUgAiAEBEhwKD2luaXRpYWxfY29udGVudBgCIAEoCUgBiAEBQgoKCF9jb250ZW50QhIKEF9pbml0aWFsX2NvbnRlbnQiaAoSRmlsZVN0YXRlU3RydWN0dXJlEhQKB2NvbnRlbnQYASABKAxIAIgBARIcCg9pbml0aWFsX2NvbnRlbnQYAiABKAxIAYgBAUIKCghfY29udGVudEISChBfaW5pdGlhbF9jb250ZW50IjcKClN0ZXBUaW1pbmcSEwoLZHVyYXRpb25fbXMYASABKAQSFAoMdGltZXN0YW1wX21zGAIgASgEIvYEChFDb252ZXJzYXRpb25TdGF0ZRIhChlyb290X3Byb21wdF9tZXNzYWdlc19qc29uGAEgAygJEikKBXR1cm5zGAggAygLMhouYWdlbnQudjEuQ29udmVyc2F0aW9uVHVybhIhCgV0b2RvcxgDIAMoCzISLmFnZW50LnYxLlRvZG9JdGVtEhoKEnBlbmRpbmdfdG9vbF9jYWxscxgEIAMoCRI5Cg10b2tlbl9kZXRhaWxzGAUgASgLMiIuYWdlbnQudjEuQ29udmVyc2F0aW9uVG9rZW5EZXRhaWxzEjMKB3N1bW1hcnkYBiABKAsyHS5hZ2VudC52MS5Db252ZXJzYXRpb25TdW1tYXJ5SACIAQESLQoEcGxhbhgHIAEoCzIaLmFnZW50LnYxLkNvbnZlcnNhdGlvblBsYW5IAYgBARJCCg9zdW1tYXJ5X2FyY2hpdmUYCSABKAsyJC5hZ2VudC52MS5Db252ZXJzYXRpb25TdW1tYXJ5QXJjaGl2ZUgCiAEBEkAKC2ZpbGVfc3RhdGVzGAogAygLMisuYWdlbnQudjEuQ29udmVyc2F0aW9uU3RhdGUuRmlsZVN0YXRlc0VudHJ5Ej4KEHN1bW1hcnlfYXJjaGl2ZXMYCyADKAsyJC5hZ2VudC52MS5Db252ZXJzYXRpb25TdW1tYXJ5QXJjaGl2ZRpGCg9GaWxlU3RhdGVzRW50cnkSCwoDa2V5GAEgASgJEiIKBXZhbHVlGAIgASgLMhMuYWdlbnQudjEuRmlsZVN0YXRlOgI4AUIKCghfc3VtbWFyeUIHCgVfcGxhbkISChBfc3VtbWFyeV9hcmNoaXZlIscBChZTdWJhZ2VudFBlcnNpc3RlZFN0YXRlEkAKEmNvbnZlcnNhdGlvbl9zdGF0ZRgBIAEoCzIkLmFnZW50LnYxLkNvbnZlcnNhdGlvblN0YXRlU3RydWN0dXJlEhwKFGNyZWF0ZWRfdGltZXN0YW1wX21zGAIgASgEEh4KFmxhc3RfdXNlZF90aW1lc3RhbXBfbXMYAyABKAQSLQoNc3ViYWdlbnRfdHlwZRgEIAEoCzIWLmFnZW50LnYxLlN1YmFnZW50VHlwZSK3BwoaQ29udmVyc2F0aW9uU3RhdGVTdHJ1Y3R1cmUSEQoJdHVybnNfb2xkGAIgAygMEiEKGXJvb3RfcHJvbXB0X21lc3NhZ2VzX2pzb24YASADKAwSDQoFdHVybnMYCCADKAwSDQoFdG9kb3MYAyADKAwSGgoScGVuZGluZ190b29sX2NhbGxzGAQgAygJEjkKDXRva2VuX2RldGFpbHMYBSABKAsyIi5hZ2VudC52MS5Db252ZXJzYXRpb25Ub2tlbkRldGFpbHMSFAoHc3VtbWFyeRgGIAEoDEgAiAEBEhEKBHBsYW4YByABKAxIAYgBARIfChdwcmV2aW91c193b3Jrc3BhY2VfdXJpcxgJIAMoCRIRCgRtb2RlGAogASgFSAKIAQESHAoPc3VtbWFyeV9hcmNoaXZlGAsgASgMSAOIAQESSQoLZmlsZV9zdGF0ZXMYDCADKAsyNC5hZ2VudC52MS5Db252ZXJzYXRpb25TdGF0ZVN0cnVjdHVyZS5GaWxlU3RhdGVzRW50cnkSTgoOZmlsZV9zdGF0ZXNfdjIYDyADKAsyNi5hZ2VudC52MS5Db252ZXJzYXRpb25TdGF0ZVN0cnVjdHVyZS5GaWxlU3RhdGVzVjJFbnRyeRIYChBzdW1tYXJ5X2FyY2hpdmVzGA0gAygMEioKDHR1cm5fdGltaW5ncxgOIAMoCzIULmFnZW50LnYxLlN0ZXBUaW1pbmcSUQoPc3ViYWdlbnRfc3RhdGVzGBAgAygLMjguYWdlbnQudjEuQ29udmVyc2F0aW9uU3RhdGVTdHJ1Y3R1cmUuU3ViYWdlbnRTdGF0ZXNFbnRyeRIaChJzZWxmX3N1bW1hcnlfY291bnQYESABKA0SEgoKcmVhZF9wYXRocxgSIAMoCRoxCg9GaWxlU3RhdGVzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgMOgI4ARpRChFGaWxlU3RhdGVzVjJFbnRyeRILCgNrZXkYASABKAkSKwoFdmFsdWUYAiABKAsyHC5hZ2VudC52MS5GaWxlU3RhdGVTdHJ1Y3R1cmU6AjgBGlcKE1N1YmFnZW50U3RhdGVzRW50cnkSCwoDa2V5GAEgASgJEi8KBXZhbHVlGAIgASgLMiAuYWdlbnQudjEuU3ViYWdlbnRQZXJzaXN0ZWRTdGF0ZToCOAFCCgoIX3N1bW1hcnlCBwoFX3BsYW5CBwoFX21vZGVCEgoQX3N1bW1hcnlfYXJjaGl2ZSIRCg9UaGlua2luZ0RldGFpbHMiSAoRQXBpS2V5Q3JlZGVudGlhbHMSDwoHYXBpX2tleRgBIAEoCRIVCghiYXNlX3VybBgCIAEoCUgAiAEBQgsKCV9iYXNlX3VybCJJChBBenVyZUNyZWRlbnRpYWxzEg8KB2FwaV9rZXkYASABKAkSEAoIYmFzZV91cmwYAiABKAkSEgoKZGVwbG95bWVudBgDIAEoCSJ6ChJCZWRyb2NrQ3JlZGVudGlhbHMSEgoKYWNjZXNzX2tleRgBIAEoCRISCgpzZWNyZXRfa2V5GAIgASgJEg4KBnJlZ2lvbhgDIAEoCRIaCg1zZXNzaW9uX3Rva2VuGAQgASgJSACIAQFCEAoOX3Nlc3Npb25fdG9rZW4isQMKDE1vZGVsRGV0YWlscxIQCghtb2RlbF9pZBgBIAEoCRIYChBkaXNwbGF5X21vZGVsX2lkGAMgASgJEhQKDGRpc3BsYXlfbmFtZRgEIAEoCRIaChJkaXNwbGF5X25hbWVfc2hvcnQYBSABKAkSDwoHYWxpYXNlcxgGIAMoCRI4ChB0aGlua2luZ19kZXRhaWxzGAIgASgLMhkuYWdlbnQudjEuVGhpbmtpbmdEZXRhaWxzSAGIAQESFQoIbWF4X21vZGUYByABKAhIAogBARI6ChNhcGlfa2V5X2NyZWRlbnRpYWxzGAggASgLMhsuYWdlbnQudjEuQXBpS2V5Q3JlZGVudGlhbHNIABI3ChFhenVyZV9jcmVkZW50aWFscxgJIAEoCzIaLmFnZW50LnYxLkF6dXJlQ3JlZGVudGlhbHNIABI7ChNiZWRyb2NrX2NyZWRlbnRpYWxzGAogASgLMhwuYWdlbnQudjEuQmVkcm9ja0NyZWRlbnRpYWxzSABCDQoLY3JlZGVudGlhbHNCEwoRX3RoaW5raW5nX2RldGFpbHNCCwoJX21heF9tb2RlIrcCCg5SZXF1ZXN0ZWRNb2RlbBIQCghtb2RlbF9pZBgBIAEoCRIQCghtYXhfbW9kZRgCIAEoCBJACgpwYXJhbWV0ZXJzGAMgAygLMiwuYWdlbnQudjEuUmVxdWVzdGVkTW9kZWxfTW9kZWxQYXJhbWV0ZXJieXRlcxI6ChNhcGlfa2V5X2NyZWRlbnRpYWxzGAQgASgLMhsuYWdlbnQudjEuQXBpS2V5Q3JlZGVudGlhbHNIABI3ChFhenVyZV9jcmVkZW50aWFscxgFIAEoCzIaLmFnZW50LnYxLkF6dXJlQ3JlZGVudGlhbHNIABI7ChNiZWRyb2NrX2NyZWRlbnRpYWxzGAYgASgLMhwuYWdlbnQudjEuQmVkcm9ja0NyZWRlbnRpYWxzSABCDQoLY3JlZGVudGlhbHMiPwoiUmVxdWVzdGVkTW9kZWxfTW9kZWxQYXJhbWV0ZXJieXRlcxIKCgJpZBgBIAEoCRINCgV2YWx1ZRgCIAEoCSK5BAoPQWdlbnRSdW5SZXF1ZXN0EkAKEmNvbnZlcnNhdGlvbl9zdGF0ZRgBIAEoCzIkLmFnZW50LnYxLkNvbnZlcnNhdGlvblN0YXRlU3RydWN0dXJlEiwKBmFjdGlvbhgCIAEoCzIcLmFnZW50LnYxLkNvbnZlcnNhdGlvbkFjdGlvbhItCg1tb2RlbF9kZXRhaWxzGAMgASgLMhYuYWdlbnQudjEuTW9kZWxEZXRhaWxzEjYKD3JlcXVlc3RlZF9tb2RlbBgJIAEoCzIYLmFnZW50LnYxLlJlcXVlc3RlZE1vZGVsSACIAQESJQoJbWNwX3Rvb2xzGAQgASgLMhIuYWdlbnQudjEuTWNwVG9vbHMSHAoPY29udmVyc2F0aW9uX2lkGAUgASgJSAGIAQESRAoXbWNwX2ZpbGVfc3lzdGVtX29wdGlvbnMYBiABKAsyHi5hZ2VudC52MS5NY3BGaWxlU3lzdGVtT3B0aW9uc0gCiAEBEjIKDXNraWxsX29wdGlvbnMYByABKAsyFi5hZ2VudC52MS5Ta2lsbE9wdGlvbnNIA4gBARIhChRjdXN0b21fc3lzdGVtX3Byb21wdBgIIAEoCUgEiAEBQhIKEF9yZXF1ZXN0ZWRfbW9kZWxCEgoQX2NvbnZlcnNhdGlvbl9pZEIaChhfbWNwX2ZpbGVfc3lzdGVtX29wdGlvbnNCEAoOX3NraWxsX29wdGlvbnNCFwoVX2N1c3RvbV9zeXN0ZW1fcHJvbXB0Ih8KD1RleHREZWx0YVVwZGF0ZRIMCgR0ZXh0GAEgASgJImYKFVRvb2xDYWxsU3RhcnRlZFVwZGF0ZRIPCgdjYWxsX2lkGAEgASgJEiUKCXRvb2xfY2FsbBgCIAEoCzISLmFnZW50LnYxLlRvb2xDYWxsEhUKDW1vZGVsX2NhbGxfaWQYAyABKAkiaAoXVG9vbENhbGxDb21wbGV0ZWRVcGRhdGUSDwoHY2FsbF9pZBgBIAEoCRIlCgl0b29sX2NhbGwYAiABKAsyEi5hZ2VudC52MS5Ub29sQ2FsbBIVCg1tb2RlbF9jYWxsX2lkGAMgASgJIm8KE1Rvb2xDYWxsRGVsdGFVcGRhdGUSDwoHY2FsbF9pZBgBIAEoCRIwCg90b29sX2NhbGxfZGVsdGEYAiABKAsyFy5hZ2VudC52MS5Ub29sQ2FsbERlbHRhEhUKDW1vZGVsX2NhbGxfaWQYAyABKAkifwoVUGFydGlhbFRvb2xDYWxsVXBkYXRlEg8KB2NhbGxfaWQYASABKAkSJQoJdG9vbF9jYWxsGAIgASgLMhIuYWdlbnQudjEuVG9vbENhbGwSFwoPYXJnc190ZXh0X2RlbHRhGAMgASgJEhUKDW1vZGVsX2NhbGxfaWQYBCABKAkiIwoTVGhpbmtpbmdEZWx0YVVwZGF0ZRIMCgR0ZXh0GAEgASgJIjcKF1RoaW5raW5nQ29tcGxldGVkVXBkYXRlEhwKFHRoaW5raW5nX2R1cmF0aW9uX21zGAEgASgFIiIKEFRva2VuRGVsdGFVcGRhdGUSDgoGdG9rZW5zGAEgASgFIiAKDVN1bW1hcnlVcGRhdGUSDwoHc3VtbWFyeRgBIAEoCSIWChRTdW1tYXJ5U3RhcnRlZFVwZGF0ZSIRCg9IZWFydGJlYXRVcGRhdGUiGAoWU3VtbWFyeUNvbXBsZXRlZFVwZGF0ZSLXAQoWU2hlbGxPdXRwdXREZWx0YVVwZGF0ZRItCgZzdGRvdXQYASABKAsyGy5hZ2VudC52MS5TaGVsbFN0cmVhbVN0ZG91dEgAEi0KBnN0ZGVychgCIAEoCzIbLmFnZW50LnYxLlNoZWxsU3RyZWFtU3RkZXJySAASKQoEZXhpdBgDIAEoCzIZLmFnZW50LnYxLlNoZWxsU3RyZWFtRXhpdEgAEisKBXN0YXJ0GAQgASgLMhouYWdlbnQudjEuU2hlbGxTdHJlYW1TdGFydEgAQgcKBWV2ZW50IhEKD1R1cm5FbmRlZFVwZGF0ZSJIChlVc2VyTWVzc2FnZUFwcGVuZGVkVXBkYXRlEisKDHVzZXJfbWVzc2FnZRgBIAEoCzIVLmFnZW50LnYxLlVzZXJNZXNzYWdlIiQKEVN0ZXBTdGFydGVkVXBkYXRlEg8KB3N0ZXBfaWQYASABKAQiQAoTU3RlcENvbXBsZXRlZFVwZGF0ZRIPCgdzdGVwX2lkGAEgASgEEhgKEHN0ZXBfZHVyYXRpb25fbXMYAiABKAMi7wcKEUludGVyYWN0aW9uVXBkYXRlEi8KCnRleHRfZGVsdGEYASABKAsyGS5hZ2VudC52MS5UZXh0RGVsdGFVcGRhdGVIABI8ChFwYXJ0aWFsX3Rvb2xfY2FsbBgHIAEoCzIfLmFnZW50LnYxLlBhcnRpYWxUb29sQ2FsbFVwZGF0ZUgAEjgKD3Rvb2xfY2FsbF9kZWx0YRgPIAEoCzIdLmFnZW50LnYxLlRvb2xDYWxsRGVsdGFVcGRhdGVIABI8ChF0b29sX2NhbGxfc3RhcnRlZBgCIAEoCzIfLmFnZW50LnYxLlRvb2xDYWxsU3RhcnRlZFVwZGF0ZUgAEkAKE3Rvb2xfY2FsbF9jb21wbGV0ZWQYAyABKAsyIS5hZ2VudC52MS5Ub29sQ2FsbENvbXBsZXRlZFVwZGF0ZUgAEjcKDnRoaW5raW5nX2RlbHRhGAQgASgLMh0uYWdlbnQudjEuVGhpbmtpbmdEZWx0YVVwZGF0ZUgAEj8KEnRoaW5raW5nX2NvbXBsZXRlZBgFIAEoCzIhLmFnZW50LnYxLlRoaW5raW5nQ29tcGxldGVkVXBkYXRlSAASRAoVdXNlcl9tZXNzYWdlX2FwcGVuZGVkGAYgASgLMiMuYWdlbnQudjEuVXNlck1lc3NhZ2VBcHBlbmRlZFVwZGF0ZUgAEjEKC3Rva2VuX2RlbHRhGAggASgLMhouYWdlbnQudjEuVG9rZW5EZWx0YVVwZGF0ZUgAEioKB3N1bW1hcnkYCSABKAsyFy5hZ2VudC52MS5TdW1tYXJ5VXBkYXRlSAASOQoPc3VtbWFyeV9zdGFydGVkGAogASgLMh4uYWdlbnQudjEuU3VtbWFyeVN0YXJ0ZWRVcGRhdGVIABI9ChFzdW1tYXJ5X2NvbXBsZXRlZBgLIAEoCzIgLmFnZW50LnYxLlN1bW1hcnlDb21wbGV0ZWRVcGRhdGVIABI+ChJzaGVsbF9vdXRwdXRfZGVsdGEYDCABKAsyIC5hZ2VudC52MS5TaGVsbE91dHB1dERlbHRhVXBkYXRlSAASLgoJaGVhcnRiZWF0GA0gASgLMhkuYWdlbnQudjEuSGVhcnRiZWF0VXBkYXRlSAASLwoKdHVybl9lbmRlZBgOIAEoCzIZLmFnZW50LnYxLlR1cm5FbmRlZFVwZGF0ZUgAEjMKDHN0ZXBfc3RhcnRlZBgQIAEoCzIbLmFnZW50LnYxLlN0ZXBTdGFydGVkVXBkYXRlSAASNwoOc3RlcF9jb21wbGV0ZWQYESABKAsyHS5hZ2VudC52MS5TdGVwQ29tcGxldGVkVXBkYXRlSABCCQoHbWVzc2FnZSKaBAoQSW50ZXJhY3Rpb25RdWVyeRIKCgJpZBgBIAEoDRJDChh3ZWJfc2VhcmNoX3JlcXVlc3RfcXVlcnkYAiABKAsyHy5hZ2VudC52MS5XZWJTZWFyY2hSZXF1ZXN0UXVlcnlIABJPCh5hc2tfcXVlc3Rpb25faW50ZXJhY3Rpb25fcXVlcnkYAyABKAsyJS5hZ2VudC52MS5Bc2tRdWVzdGlvbkludGVyYWN0aW9uUXVlcnlIABJFChlzd2l0Y2hfbW9kZV9yZXF1ZXN0X3F1ZXJ5GAQgASgLMiAuYWdlbnQudjEuU3dpdGNoTW9kZVJlcXVlc3RRdWVyeUgAEkMKGGV4YV9zZWFyY2hfcmVxdWVzdF9xdWVyeRgFIAEoCzIfLmFnZW50LnYxLkV4YVNlYXJjaFJlcXVlc3RRdWVyeUgAEkEKF2V4YV9mZXRjaF9yZXF1ZXN0X3F1ZXJ5GAYgASgLMh4uYWdlbnQudjEuRXhhRmV0Y2hSZXF1ZXN0UXVlcnlIABJFChljcmVhdGVfcGxhbl9yZXF1ZXN0X3F1ZXJ5GAcgASgLMiAuYWdlbnQudjEuQ3JlYXRlUGxhblJlcXVlc3RRdWVyeUgAEkUKGXNldHVwX3ZtX2Vudmlyb25tZW50X2FyZ3MYCCABKAsyIC5hZ2VudC52MS5TZXR1cFZtRW52aXJvbm1lbnRBcmdzSABCBwoFcXVlcnkixgQKE0ludGVyYWN0aW9uUmVzcG9uc2USCgoCaWQYASABKA0SSQobd2ViX3NlYXJjaF9yZXF1ZXN0X3Jlc3BvbnNlGAIgASgLMiIuYWdlbnQudjEuV2ViU2VhcmNoUmVxdWVzdFJlc3BvbnNlSAASVQohYXNrX3F1ZXN0aW9uX2ludGVyYWN0aW9uX3Jlc3BvbnNlGAMgASgLMiguYWdlbnQudjEuQXNrUXVlc3Rpb25JbnRlcmFjdGlvblJlc3BvbnNlSAASSwocc3dpdGNoX21vZGVfcmVxdWVzdF9yZXNwb25zZRgEIAEoCzIjLmFnZW50LnYxLlN3aXRjaE1vZGVSZXF1ZXN0UmVzcG9uc2VIABJJChtleGFfc2VhcmNoX3JlcXVlc3RfcmVzcG9uc2UYBSABKAsyIi5hZ2VudC52MS5FeGFTZWFyY2hSZXF1ZXN0UmVzcG9uc2VIABJHChpleGFfZmV0Y2hfcmVxdWVzdF9yZXNwb25zZRgGIAEoCzIhLmFnZW50LnYxLkV4YUZldGNoUmVxdWVzdFJlc3BvbnNlSAASSwocY3JlYXRlX3BsYW5fcmVxdWVzdF9yZXNwb25zZRgHIAEoCzIjLmFnZW50LnYxLkNyZWF0ZVBsYW5SZXF1ZXN0UmVzcG9uc2VIABJJChtzZXR1cF92bV9lbnZpcm9ubWVudF9yZXN1bHQYCCABKAsyIi5hZ2VudC52MS5TZXR1cFZtRW52aXJvbm1lbnRSZXN1bHRIAEIICgZyZXN1bHQiXAobQXNrUXVlc3Rpb25JbnRlcmFjdGlvblF1ZXJ5EicKBGFyZ3MYASABKAsyGS5hZ2VudC52MS5Bc2tRdWVzdGlvbkFyZ3MSFAoMdG9vbF9jYWxsX2lkGAIgASgJIk0KHkFza1F1ZXN0aW9uSW50ZXJhY3Rpb25SZXNwb25zZRIrCgZyZXN1bHQYASABKAsyGy5hZ2VudC52MS5Bc2tRdWVzdGlvblJlc3VsdCIRCg9DbGllbnRIZWFydGJlYXQixgQKDlByZXdhcm1SZXF1ZXN0Ei0KDW1vZGVsX2RldGFpbHMYASABKAsyFi5hZ2VudC52MS5Nb2RlbERldGFpbHMSNgoPcmVxdWVzdGVkX21vZGVsGAkgASgLMhguYWdlbnQudjEuUmVxdWVzdGVkTW9kZWxIAIgBARIcCg9jb252ZXJzYXRpb25faWQYAiABKAlIAYgBARJAChJjb252ZXJzYXRpb25fc3RhdGUYAyABKAsyJC5hZ2VudC52MS5Db252ZXJzYXRpb25TdGF0ZVN0cnVjdHVyZRIlCgltY3BfdG9vbHMYBCABKAsyEi5hZ2VudC52MS5NY3BUb29scxJEChdtY3BfZmlsZV9zeXN0ZW1fb3B0aW9ucxgFIAEoCzIeLmFnZW50LnYxLk1jcEZpbGVTeXN0ZW1PcHRpb25zSAKIAQESHwoSYmVzdF9vZl9uX2dyb3VwX2lkGAYgASgJSAOIAQESKAobdHJ5X3VzZV9iZXN0X29mX25fcHJvbW90aW9uGAcgASgISASIAQESIQoUY3VzdG9tX3N5c3RlbV9wcm9tcHQYCCABKAlIBYgBAUISChBfcmVxdWVzdGVkX21vZGVsQhIKEF9jb252ZXJzYXRpb25faWRCGgoYX21jcF9maWxlX3N5c3RlbV9vcHRpb25zQhUKE19iZXN0X29mX25fZ3JvdXBfaWRCHgocX3RyeV91c2VfYmVzdF9vZl9uX3Byb21vdGlvbkIXChVfY3VzdG9tX3N5c3RlbV9wcm9tcHQiHQoPRXhlY1NlcnZlckFib3J0EgoKAmlkGAEgASgNIlEKGEV4ZWNTZXJ2ZXJDb250cm9sTWVzc2FnZRIqCgVhYm9ydBgBIAEoCzIZLmFnZW50LnYxLkV4ZWNTZXJ2ZXJBYm9ydEgAQgkKB21lc3NhZ2Ui+AMKEkFnZW50Q2xpZW50TWVzc2FnZRIwCgtydW5fcmVxdWVzdBgBIAEoCzIZLmFnZW50LnYxLkFnZW50UnVuUmVxdWVzdEgAEjoKE2V4ZWNfY2xpZW50X21lc3NhZ2UYAiABKAsyGy5hZ2VudC52MS5FeGVjQ2xpZW50TWVzc2FnZUgAEkkKG2V4ZWNfY2xpZW50X2NvbnRyb2xfbWVzc2FnZRgFIAEoCzIiLmFnZW50LnYxLkV4ZWNDbGllbnRDb250cm9sTWVzc2FnZUgAEjYKEWt2X2NsaWVudF9tZXNzYWdlGAMgASgLMhkuYWdlbnQudjEuS3ZDbGllbnRNZXNzYWdlSAASOwoTY29udmVyc2F0aW9uX2FjdGlvbhgEIAEoCzIcLmFnZW50LnYxLkNvbnZlcnNhdGlvbkFjdGlvbkgAEj0KFGludGVyYWN0aW9uX3Jlc3BvbnNlGAYgASgLMh0uYWdlbnQudjEuSW50ZXJhY3Rpb25SZXNwb25zZUgAEjUKEGNsaWVudF9oZWFydGJlYXQYByABKAsyGS5hZ2VudC52MS5DbGllbnRIZWFydGJlYXRIABIzCg9wcmV3YXJtX3JlcXVlc3QYCCABKAsyGC5hZ2VudC52MS5QcmV3YXJtUmVxdWVzdEgAQgkKB21lc3NhZ2UiogMKEkFnZW50U2VydmVyTWVzc2FnZRI5ChJpbnRlcmFjdGlvbl91cGRhdGUYASABKAsyGy5hZ2VudC52MS5JbnRlcmFjdGlvblVwZGF0ZUgAEjoKE2V4ZWNfc2VydmVyX21lc3NhZ2UYAiABKAsyGy5hZ2VudC52MS5FeGVjU2VydmVyTWVzc2FnZUgAEkkKG2V4ZWNfc2VydmVyX2NvbnRyb2xfbWVzc2FnZRgFIAEoCzIiLmFnZW50LnYxLkV4ZWNTZXJ2ZXJDb250cm9sTWVzc2FnZUgAEk4KHmNvbnZlcnNhdGlvbl9jaGVja3BvaW50X3VwZGF0ZRgDIAEoCzIkLmFnZW50LnYxLkNvbnZlcnNhdGlvblN0YXRlU3RydWN0dXJlSAASNgoRa3Zfc2VydmVyX21lc3NhZ2UYBCABKAsyGS5hZ2VudC52MS5LdlNlcnZlck1lc3NhZ2VIABI3ChFpbnRlcmFjdGlvbl9xdWVyeRgHIAEoCzIaLmFnZW50LnYxLkludGVyYWN0aW9uUXVlcnlIAEIJCgdtZXNzYWdlIigKEE5hbWVBZ2VudFJlcXVlc3QSFAoMdXNlcl9tZXNzYWdlGAEgASgJIiEKEU5hbWVBZ2VudFJlc3BvbnNlEgwKBG5hbWUYASABKAkiMgoWR2V0VXNhYmxlTW9kZWxzUmVxdWVzdBIYChBjdXN0b21fbW9kZWxfaWRzGAEgAygJIkEKF0dldFVzYWJsZU1vZGVsc1Jlc3BvbnNlEiYKBm1vZGVscxgBIAMoCzIWLmFnZW50LnYxLk1vZGVsRGV0YWlscyIeChxHZXREZWZhdWx0TW9kZWxGb3JDbGlSZXF1ZXN0IkYKHUdldERlZmF1bHRNb2RlbEZvckNsaVJlc3BvbnNlEiUKBW1vZGVsGAEgASgLMhYuYWdlbnQudjEuTW9kZWxEZXRhaWxzIh8KHUdldEFsbG93ZWRNb2RlbEludGVudHNSZXF1ZXN0IjcKHkdldEFsbG93ZWRNb2RlbEludGVudHNSZXNwb25zZRIVCg1tb2RlbF9pbnRlbnRzGAEgAygJIpcCChNJZGVFZGl0b3JzU3RhdGVGaWxlEhUKDXJlbGF0aXZlX3BhdGgYASABKAkSFQoNYWJzb2x1dGVfcGF0aBgCIAEoCRIhChRpc19jdXJyZW50bHlfZm9jdXNlZBgDIAEoCEgAiAEBEiAKE2N1cnJlbnRfbGluZV9udW1iZXIYBCABKAVIAYgBARIeChFjdXJyZW50X2xpbmVfdGV4dBgFIAEoCUgCiAEBEhcKCmxpbmVfY291bnQYBiABKAVIA4gBAUIXChVfaXNfY3VycmVudGx5X2ZvY3VzZWRCFgoUX2N1cnJlbnRfbGluZV9udW1iZXJCFAoSX2N1cnJlbnRfbGluZV90ZXh0Qg0KC19saW5lX2NvdW50IlMKE0lkZUVkaXRvcnNTdGF0ZUxpdGUSPAoVcmVjZW50bHlfdmlld2VkX2ZpbGVzGAEgAygLMh0uYWdlbnQudjEuSWRlRWRpdG9yc1N0YXRlRmlsZSJ0ChZBcHBseUFnZW50RGlmZlRvb2xDYWxsEioKBGFyZ3MYASABKAsyHC5hZ2VudC52MS5BcHBseUFnZW50RGlmZkFyZ3MSLgoGcmVzdWx0GAIgASgLMh4uYWdlbnQudjEuQXBwbHlBZ2VudERpZmZSZXN1bHQiJgoSQXBwbHlBZ2VudERpZmZBcmdzEhAKCGFnZW50X2lkGAEgASgJIoQBChRBcHBseUFnZW50RGlmZlJlc3VsdBIyCgdzdWNjZXNzGAEgASgLMh8uYWdlbnQudjEuQXBwbHlBZ2VudERpZmZTdWNjZXNzSAASLgoFZXJyb3IYAiABKAsyHS5hZ2VudC52MS5BcHBseUFnZW50RGlmZkVycm9ySABCCAoGcmVzdWx0Ik4KFUFwcGx5QWdlbnREaWZmU3VjY2VzcxI1Cg9hcHBsaWVkX2NoYW5nZXMYASADKAsyHC5hZ2VudC52MS5BcHBsaWVkQWdlbnRDaGFuZ2Ui6QEKEkFwcGxpZWRBZ2VudENoYW5nZRIMCgRwYXRoGAEgASgJEhMKC2NoYW5nZV90eXBlGAIgASgFEhsKDmJlZm9yZV9jb250ZW50GAMgASgJSACIAQESGgoNYWZ0ZXJfY29udGVudBgEIAEoCUgBiAEBEhIKBWVycm9yGAUgASgJSAKIAQESHgoRbWVzc2FnZV9mb3JfbW9kZWwYBiABKAlIA4gBAUIRCg9fYmVmb3JlX2NvbnRlbnRCEAoOX2FmdGVyX2NvbnRlbnRCCAoGX2Vycm9yQhQKEl9tZXNzYWdlX2Zvcl9tb2RlbCJbChNBcHBseUFnZW50RGlmZkVycm9yEg0KBWVycm9yGAEgASgJEjUKD2FwcGxpZWRfY2hhbmdlcxgCIAMoCzIcLmFnZW50LnYxLkFwcGxpZWRBZ2VudENoYW5nZSJrChNBc2tRdWVzdGlvblRvb2xDYWxsEicKBGFyZ3MYASABKAsyGS5hZ2VudC52MS5Bc2tRdWVzdGlvbkFyZ3MSKwoGcmVzdWx0GAIgASgLMhsuYWdlbnQudjEuQXNrUXVlc3Rpb25SZXN1bHQijwEKD0Fza1F1ZXN0aW9uQXJncxINCgV0aXRsZRgBIAEoCRI1CglxdWVzdGlvbnMYAiADKAsyIi5hZ2VudC52MS5Bc2tRdWVzdGlvbkFyZ3NfUXVlc3Rpb24SEQoJcnVuX2FzeW5jGAUgASgIEiMKG2FzeW5jX29yaWdpbmFsX3Rvb2xfY2FsbF9pZBgGIAEoCSKBAQoYQXNrUXVlc3Rpb25BcmdzX1F1ZXN0aW9uEgoKAmlkGAEgASgJEg4KBnByb21wdBgCIAEoCRIxCgdvcHRpb25zGAMgAygLMiAuYWdlbnQudjEuQXNrUXVlc3Rpb25BcmdzX09wdGlvbhIWCg5hbGxvd19tdWx0aXBsZRgEIAEoCCIzChZBc2tRdWVzdGlvbkFyZ3NfT3B0aW9uEgoKAmlkGAEgASgJEg0KBWxhYmVsGAIgASgJIhIKEEFza1F1ZXN0aW9uQXN5bmMi2wEKEUFza1F1ZXN0aW9uUmVzdWx0Ei8KB3N1Y2Nlc3MYASABKAsyHC5hZ2VudC52MS5Bc2tRdWVzdGlvblN1Y2Nlc3NIABIrCgVlcnJvchgCIAEoCzIaLmFnZW50LnYxLkFza1F1ZXN0aW9uRXJyb3JIABIxCghyZWplY3RlZBgDIAEoCzIdLmFnZW50LnYxLkFza1F1ZXN0aW9uUmVqZWN0ZWRIABIrCgVhc3luYxgEIAEoCzIaLmFnZW50LnYxLkFza1F1ZXN0aW9uQXN5bmNIAEIICgZyZXN1bHQiSgoSQXNrUXVlc3Rpb25TdWNjZXNzEjQKB2Fuc3dlcnMYASADKAsyIy5hZ2VudC52MS5Bc2tRdWVzdGlvblN1Y2Nlc3NfQW5zd2VyIk0KGUFza1F1ZXN0aW9uU3VjY2Vzc19BbnN3ZXISEwoLcXVlc3Rpb25faWQYASABKAkSGwoTc2VsZWN0ZWRfb3B0aW9uX2lkcxgCIAMoCSIpChBBc2tRdWVzdGlvbkVycm9yEhUKDWVycm9yX21lc3NhZ2UYASABKAkiJQoTQXNrUXVlc3Rpb25SZWplY3RlZBIOCgZyZWFzb24YASABKAkiiQIKGEJhY2tncm91bmRTaGVsbFNwYXduQXJncxIPCgdjb21tYW5kGAEgASgJEhkKEXdvcmtpbmdfZGlyZWN0b3J5GAIgASgJEhQKDHRvb2xfY2FsbF9pZBgDIAEoCRI7Cg5wYXJzaW5nX3Jlc3VsdBgEIAEoCzIjLmFnZW50LnYxLlNoZWxsQ29tbWFuZFBhcnNpbmdSZXN1bHQSNAoOc2FuZGJveF9wb2xpY3kYBSABKAsyFy5hZ2VudC52MS5TYW5kYm94UG9saWN5SACIAQESJQodZW5hYmxlX3dyaXRlX3NoZWxsX3N0ZGluX3Rvb2wYBiABKAhCEQoPX3NhbmRib3hfcG9saWN5IoECChpCYWNrZ3JvdW5kU2hlbGxTcGF3blJlc3VsdBI4CgdzdWNjZXNzGAEgASgLMiUuYWdlbnQudjEuQmFja2dyb3VuZFNoZWxsU3Bhd25TdWNjZXNzSAASNAoFZXJyb3IYAiABKAsyIy5hZ2VudC52MS5CYWNrZ3JvdW5kU2hlbGxTcGF3bkVycm9ySAASKwoIcmVqZWN0ZWQYAyABKAsyFy5hZ2VudC52MS5TaGVsbFJlamVjdGVkSAASPAoRcGVybWlzc2lvbl9kZW5pZWQYBCABKAsyHy5hZ2VudC52MS5TaGVsbFBlcm1pc3Npb25EZW5pZWRIAEIICgZyZXN1bHQidQobQmFja2dyb3VuZFNoZWxsU3Bhd25TdWNjZXNzEhAKCHNoZWxsX2lkGAEgASgNEg8KB2NvbW1hbmQYAiABKAkSGQoRd29ya2luZ19kaXJlY3RvcnkYAyABKAkSEAoDcGlkGAQgASgNSACIAQFCBgoEX3BpZCJWChlCYWNrZ3JvdW5kU2hlbGxTcGF3bkVycm9yEg8KB2NvbW1hbmQYASABKAkSGQoRd29ya2luZ19kaXJlY3RvcnkYAiABKAkSDQoFZXJyb3IYAyABKAkiNgoTV3JpdGVTaGVsbFN0ZGluQXJncxIQCghzaGVsbF9pZBgBIAEoDRINCgVjaGFycxgCIAEoCSKHAQoVV3JpdGVTaGVsbFN0ZGluUmVzdWx0EjMKB3N1Y2Nlc3MYASABKAsyIC5hZ2VudC52MS5Xcml0ZVNoZWxsU3RkaW5TdWNjZXNzSAASLwoFZXJyb3IYAiABKAsyHi5hZ2VudC52MS5Xcml0ZVNoZWxsU3RkaW5FcnJvckgAQggKBnJlc3VsdCJdChZXcml0ZVNoZWxsU3RkaW5TdWNjZXNzEhAKCHNoZWxsX2lkGAEgASgNEjEKKXRlcm1pbmFsX2ZpbGVfbGVuZ3RoX2JlZm9yZV9pbnB1dF93cml0dGVuGAIgASgNIiUKFFdyaXRlU2hlbGxTdGRpbkVycm9yEg0KBWVycm9yGAEgASgJIiIKCkNvb3JkaW5hdGUSCQoBeBgBIAEoBRIJCgF5GAIgASgFIlUKD0NvbXB1dGVyVXNlQXJncxIUCgx0b29sX2NhbGxfaWQYASABKAkSLAoHYWN0aW9ucxgCIAMoCzIbLmFnZW50LnYxLkNvbXB1dGVyVXNlQWN0aW9uIoEEChFDb21wdXRlclVzZUFjdGlvbhIvCgptb3VzZV9tb3ZlGAEgASgLMhkuYWdlbnQudjEuTW91c2VNb3ZlQWN0aW9uSAASJgoFY2xpY2sYAiABKAsyFS5hZ2VudC52MS5DbGlja0FjdGlvbkgAEi8KCm1vdXNlX2Rvd24YAyABKAsyGS5hZ2VudC52MS5Nb3VzZURvd25BY3Rpb25IABIrCghtb3VzZV91cBgEIAEoCzIXLmFnZW50LnYxLk1vdXNlVXBBY3Rpb25IABIkCgRkcmFnGAUgASgLMhQuYWdlbnQudjEuRHJhZ0FjdGlvbkgAEigKBnNjcm9sbBgGIAEoCzIWLmFnZW50LnYxLlNjcm9sbEFjdGlvbkgAEiQKBHR5cGUYByABKAsyFC5hZ2VudC52MS5UeXBlQWN0aW9uSAASIgoDa2V5GAggASgLMhMuYWdlbnQudjEuS2V5QWN0aW9uSAASJAoEd2FpdBgJIAEoCzIULmFnZW50LnYxLldhaXRBY3Rpb25IABIwCgpzY3JlZW5zaG90GAogASgLMhouYWdlbnQudjEuU2NyZWVuc2hvdEFjdGlvbkgAEjkKD2N1cnNvcl9wb3NpdGlvbhgLIAEoCzIeLmFnZW50LnYxLkN1cnNvclBvc2l0aW9uQWN0aW9uSABCCAoGYWN0aW9uIjsKD01vdXNlTW92ZUFjdGlvbhIoCgpjb29yZGluYXRlGAEgASgLMhQuYWdlbnQudjEuQ29vcmRpbmF0ZSKYAQoLQ2xpY2tBY3Rpb24SLQoKY29vcmRpbmF0ZRgBIAEoCzIULmFnZW50LnYxLkNvb3JkaW5hdGVIAIgBARIOCgZidXR0b24YAiABKAUSDQoFY291bnQYAyABKAUSGgoNbW9kaWZpZXJfa2V5cxgEIAEoCUgBiAEBQg0KC19jb29yZGluYXRlQhAKDl9tb2RpZmllcl9rZXlzIiEKD01vdXNlRG93bkFjdGlvbhIOCgZidXR0b24YASABKAUiHwoNTW91c2VVcEFjdGlvbhIOCgZidXR0b24YASABKAUiQAoKRHJhZ0FjdGlvbhIiCgRwYXRoGAEgAygLMhQuYWdlbnQudjEuQ29vcmRpbmF0ZRIOCgZidXR0b24YAiABKAUinQEKDFNjcm9sbEFjdGlvbhItCgpjb29yZGluYXRlGAEgASgLMhQuYWdlbnQudjEuQ29vcmRpbmF0ZUgAiAEBEhEKCWRpcmVjdGlvbhgCIAEoBRIOCgZhbW91bnQYAyABKAUSGgoNbW9kaWZpZXJfa2V5cxgEIAEoCUgBiAEBQg0KC19jb29yZGluYXRlQhAKDl9tb2RpZmllcl9rZXlzIhoKClR5cGVBY3Rpb24SDAoEdGV4dBgBIAEoCSJMCglLZXlBY3Rpb24SCwoDa2V5GAEgASgJEh0KEGhvbGRfZHVyYXRpb25fbXMYAiABKAVIAIgBAUITChFfaG9sZF9kdXJhdGlvbl9tcyIhCgpXYWl0QWN0aW9uEhMKC2R1cmF0aW9uX21zGAEgASgFIhIKEFNjcmVlbnNob3RBY3Rpb24iFgoUQ3Vyc29yUG9zaXRpb25BY3Rpb24iewoRQ29tcHV0ZXJVc2VSZXN1bHQSLwoHc3VjY2VzcxgBIAEoCzIcLmFnZW50LnYxLkNvbXB1dGVyVXNlU3VjY2Vzc0gAEisKBWVycm9yGAIgASgLMhouYWdlbnQudjEuQ29tcHV0ZXJVc2VFcnJvckgAQggKBnJlc3VsdCL7AQoSQ29tcHV0ZXJVc2VTdWNjZXNzEhQKDGFjdGlvbl9jb3VudBgBIAEoBRITCgtkdXJhdGlvbl9tcxgCIAEoBRIXCgpzY3JlZW5zaG90GAMgASgJSACIAQESEAoDbG9nGAQgASgJSAGIAQESHAoPc2NyZWVuc2hvdF9wYXRoGAUgASgJSAKIAQESMgoPY3Vyc29yX3Bvc2l0aW9uGAYgASgLMhQuYWdlbnQudjEuQ29vcmRpbmF0ZUgDiAEBQg0KC19zY3JlZW5zaG90QgYKBF9sb2dCEgoQX3NjcmVlbnNob3RfcGF0aEISChBfY3Vyc29yX3Bvc2l0aW9uIsABChBDb21wdXRlclVzZUVycm9yEg0KBWVycm9yGAEgASgJEhQKDGFjdGlvbl9jb3VudBgCIAEoBRITCgtkdXJhdGlvbl9tcxgDIAEoBRIQCgNsb2cYBCABKAlIAIgBARIXCgpzY3JlZW5zaG90GAUgASgJSAGIAQESHAoPc2NyZWVuc2hvdF9wYXRoGAYgASgJSAKIAQFCBgoEX2xvZ0INCgtfc2NyZWVuc2hvdEISChBfc2NyZWVuc2hvdF9wYXRoImsKE0NvbXB1dGVyVXNlVG9vbENhbGwSJwoEYXJncxgBIAEoCzIZLmFnZW50LnYxLkNvbXB1dGVyVXNlQXJncxIrCgZyZXN1bHQYAiABKAsyGy5hZ2VudC52MS5Db21wdXRlclVzZVJlc3VsdCJoChJDcmVhdGVQbGFuVG9vbENhbGwSJgoEYXJncxgBIAEoCzIYLmFnZW50LnYxLkNyZWF0ZVBsYW5BcmdzEioKBnJlc3VsdBgCIAEoCzIaLmFnZW50LnYxLkNyZWF0ZVBsYW5SZXN1bHQiOAoFUGhhc2USDAoEbmFtZRgBIAEoCRIhCgV0b2RvcxgCIAMoCzISLmFnZW50LnYxLlRvZG9JdGVtIpYBCg5DcmVhdGVQbGFuQXJncxIMCgRwbGFuGAEgASgJEiEKBXRvZG9zGAIgAygLMhIuYWdlbnQudjEuVG9kb0l0ZW0SEAoIb3ZlcnZpZXcYAyABKAkSDAoEbmFtZRgEIAEoCRISCgppc19wcm9qZWN0GAUgASgIEh8KBnBoYXNlcxgGIAMoCzIPLmFnZW50LnYxLlBoYXNlIooBChBDcmVhdGVQbGFuUmVzdWx0EhAKCHBsYW5fdXJpGAMgASgJEi4KB3N1Y2Nlc3MYASABKAsyGy5hZ2VudC52MS5DcmVhdGVQbGFuU3VjY2Vzc0gAEioKBWVycm9yGAIgASgLMhkuYWdlbnQudjEuQ3JlYXRlUGxhbkVycm9ySABCCAoGcmVzdWx0IhMKEUNyZWF0ZVBsYW5TdWNjZXNzIiAKD0NyZWF0ZVBsYW5FcnJvchINCgVlcnJvchgBIAEoCSJWChZDcmVhdGVQbGFuUmVxdWVzdFF1ZXJ5EiYKBGFyZ3MYASABKAsyGC5hZ2VudC52MS5DcmVhdGVQbGFuQXJncxIUCgx0b29sX2NhbGxfaWQYAiABKAkiRwoZQ3JlYXRlUGxhblJlcXVlc3RSZXNwb25zZRIqCgZyZXN1bHQYASABKAsyGi5hZ2VudC52MS5DcmVhdGVQbGFuUmVzdWx0IhYKFEN1cnNvclJ1bGVUeXBlR2xvYmFsIigKF0N1cnNvclJ1bGVUeXBlRmlsZUdsb2JzEg0KBWdsb2JzGAEgAygJIjEKGkN1cnNvclJ1bGVUeXBlQWdlbnRGZXRjaGVkEhMKC2Rlc2NyaXB0aW9uGAEgASgJIiAKHkN1cnNvclJ1bGVUeXBlTWFudWFsbHlBdHRhY2hlZCKLAgoOQ3Vyc29yUnVsZVR5cGUSMAoGZ2xvYmFsGAEgASgLMh4uYWdlbnQudjEuQ3Vyc29yUnVsZVR5cGVHbG9iYWxIABI5CgxmaWxlX2dsb2JiZWQYAiABKAsyIS5hZ2VudC52MS5DdXJzb3JSdWxlVHlwZUZpbGVHbG9ic0gAEj0KDWFnZW50X2ZldGNoZWQYAyABKAsyJC5hZ2VudC52MS5DdXJzb3JSdWxlVHlwZUFnZW50RmV0Y2hlZEgAEkUKEW1hbnVhbGx5X2F0dGFjaGVkGAQgASgLMiguYWdlbnQudjEuQ3Vyc29yUnVsZVR5cGVNYW51YWxseUF0dGFjaGVkSABCBgoEdHlwZSLIAQoKQ3Vyc29yUnVsZRIRCglmdWxsX3BhdGgYASABKAkSDwoHY29udGVudBgCIAEoCRImCgR0eXBlGAMgASgLMhguYWdlbnQudjEuQ3Vyc29yUnVsZVR5cGUSDgoGc291cmNlGAQgASgFEh4KEWdpdF9yZW1vdGVfb3JpZ2luGAUgASgJSACIAQESGAoLcGFyc2VfZXJyb3IYBiABKAlIAYgBAUIUChJfZ2l0X3JlbW90ZV9vcmlnaW5CDgoMX3BhcnNlX2Vycm9yIjAKCkRlbGV0ZUFyZ3MSDAoEcGF0aBgBIAEoCRIUCgx0b29sX2NhbGxfaWQYAiABKAki7QIKDERlbGV0ZVJlc3VsdBIqCgdzdWNjZXNzGAEgASgLMhcuYWdlbnQudjEuRGVsZXRlU3VjY2Vzc0gAEjYKDmZpbGVfbm90X2ZvdW5kGAIgASgLMhwuYWdlbnQudjEuRGVsZXRlRmlsZU5vdEZvdW5kSAASKwoIbm90X2ZpbGUYAyABKAsyFy5hZ2VudC52MS5EZWxldGVOb3RGaWxlSAASPQoRcGVybWlzc2lvbl9kZW5pZWQYBCABKAsyIC5hZ2VudC52MS5EZWxldGVQZXJtaXNzaW9uRGVuaWVkSAASLQoJZmlsZV9idXN5GAUgASgLMhguYWdlbnQudjEuRGVsZXRlRmlsZUJ1c3lIABIsCghyZWplY3RlZBgGIAEoCzIYLmFnZW50LnYxLkRlbGV0ZVJlamVjdGVkSAASJgoFZXJyb3IYByABKAsyFS5hZ2VudC52MS5EZWxldGVFcnJvckgAQggKBnJlc3VsdCJcCg1EZWxldGVTdWNjZXNzEgwKBHBhdGgYASABKAkSFAoMZGVsZXRlZF9maWxlGAIgASgJEhEKCWZpbGVfc2l6ZRgDIAEoAxIUCgxwcmV2X2NvbnRlbnQYBCABKAkiIgoSRGVsZXRlRmlsZU5vdEZvdW5kEgwKBHBhdGgYASABKAkiMgoNRGVsZXRlTm90RmlsZRIMCgRwYXRoGAEgASgJEhMKC2FjdHVhbF90eXBlGAIgASgJIlkKFkRlbGV0ZVBlcm1pc3Npb25EZW5pZWQSDAoEcGF0aBgBIAEoCRIcChRjbGllbnRfdmlzaWJsZV9lcnJvchgCIAEoCRITCgtpc19yZWFkb25seRgDIAEoCCIeCg5EZWxldGVGaWxlQnVzeRIMCgRwYXRoGAEgASgJIi4KDkRlbGV0ZVJlamVjdGVkEgwKBHBhdGgYASABKAkSDgoGcmVhc29uGAIgASgJIioKC0RlbGV0ZUVycm9yEgwKBHBhdGgYASABKAkSDQoFZXJyb3IYAiABKAkiXAoORGVsZXRlVG9vbENhbGwSIgoEYXJncxgBIAEoCzIULmFnZW50LnYxLkRlbGV0ZUFyZ3MSJgoGcmVzdWx0GAIgASgLMhYuYWdlbnQudjEuRGVsZXRlUmVzdWx0IjUKD0RpYWdub3N0aWNzQXJncxIMCgRwYXRoGAEgASgJEhQKDHRvb2xfY2FsbF9pZBgCIAEoCSKvAgoRRGlhZ25vc3RpY3NSZXN1bHQSLwoHc3VjY2VzcxgBIAEoCzIcLmFnZW50LnYxLkRpYWdub3N0aWNzU3VjY2Vzc0gAEisKBWVycm9yGAIgASgLMhouYWdlbnQudjEuRGlhZ25vc3RpY3NFcnJvckgAEjEKCHJlamVjdGVkGAMgASgLMh0uYWdlbnQudjEuRGlhZ25vc3RpY3NSZWplY3RlZEgAEjsKDmZpbGVfbm90X2ZvdW5kGAQgASgLMiEuYWdlbnQudjEuRGlhZ25vc3RpY3NGaWxlTm90Rm91bmRIABJCChFwZXJtaXNzaW9uX2RlbmllZBgFIAEoCzIlLmFnZW50LnYxLkRpYWdub3N0aWNzUGVybWlzc2lvbkRlbmllZEgAQggKBnJlc3VsdCJoChJEaWFnbm9zdGljc1N1Y2Nlc3MSDAoEcGF0aBgBIAEoCRIpCgtkaWFnbm9zdGljcxgCIAMoCzIULmFnZW50LnYxLkRpYWdub3N0aWMSGQoRdG90YWxfZGlhZ25vc3RpY3MYAyABKAUifwoKRGlhZ25vc3RpYxIQCghzZXZlcml0eRgBIAEoBRIeCgVyYW5nZRgCIAEoCzIPLmFnZW50LnYxLlJhbmdlEg8KB21lc3NhZ2UYAyABKAkSDgoGc291cmNlGAQgASgJEgwKBGNvZGUYBSABKAkSEAoIaXNfc3RhbGUYBiABKAgiLwoQRGlhZ25vc3RpY3NFcnJvchIMCgRwYXRoGAEgASgJEg0KBWVycm9yGAIgASgJIjMKE0RpYWdub3N0aWNzUmVqZWN0ZWQSDAoEcGF0aBgBIAEoCRIOCgZyZWFzb24YAiABKAkiJwoXRGlhZ25vc3RpY3NGaWxlTm90Rm91bmQSDAoEcGF0aBgBIAEoCSIrChtEaWFnbm9zdGljc1Blcm1pc3Npb25EZW5pZWQSDAoEcGF0aBgBIAEoCSJICghFZGl0QXJncxIMCgRwYXRoGAEgASgJEhsKDnN0cmVhbV9jb250ZW50GAYgASgJSACIAQFCEQoPX3N0cmVhbV9jb250ZW50ItYCCgpFZGl0UmVzdWx0EigKB3N1Y2Nlc3MYASABKAsyFS5hZ2VudC52MS5FZGl0U3VjY2Vzc0gAEjQKDmZpbGVfbm90X2ZvdW5kGAIgASgLMhouYWdlbnQudjEuRWRpdEZpbGVOb3RGb3VuZEgAEkQKFnJlYWRfcGVybWlzc2lvbl9kZW5pZWQYAyABKAsyIi5hZ2VudC52MS5FZGl0UmVhZFBlcm1pc3Npb25EZW5pZWRIABJGChd3cml0ZV9wZXJtaXNzaW9uX2RlbmllZBgEIAEoCzIjLmFnZW50LnYxLkVkaXRXcml0ZVBlcm1pc3Npb25EZW5pZWRIABIqCghyZWplY3RlZBgGIAEoCzIWLmFnZW50LnYxLkVkaXRSZWplY3RlZEgAEiQKBWVycm9yGAcgASgLMhMuYWdlbnQudjEuRWRpdEVycm9ySABCCAoGcmVzdWx0IqQCCgtFZGl0U3VjY2VzcxIMCgRwYXRoGAEgASgJEhgKC2xpbmVzX2FkZGVkGAMgASgFSACIAQESGgoNbGluZXNfcmVtb3ZlZBgEIAEoBUgBiAEBEhgKC2RpZmZfc3RyaW5nGAUgASgJSAKIAQESJQoYYmVmb3JlX2Z1bGxfZmlsZV9jb250ZW50GAYgASgJSAOIAQESHwoXYWZ0ZXJfZnVsbF9maWxlX2NvbnRlbnQYByABKAkSFAoHbWVzc2FnZRgIIAEoCUgEiAEBQg4KDF9saW5lc19hZGRlZEIQCg5fbGluZXNfcmVtb3ZlZEIOCgxfZGlmZl9zdHJpbmdCGwoZX2JlZm9yZV9mdWxsX2ZpbGVfY29udGVudEIKCghfbWVzc2FnZSIgChBFZGl0RmlsZU5vdEZvdW5kEgwKBHBhdGgYASABKAkiKAoYRWRpdFJlYWRQZXJtaXNzaW9uRGVuaWVkEgwKBHBhdGgYASABKAkiTQoZRWRpdFdyaXRlUGVybWlzc2lvbkRlbmllZBIMCgRwYXRoGAEgASgJEg0KBWVycm9yGAIgASgJEhMKC2lzX3JlYWRvbmx5GAMgASgIIiwKDEVkaXRSZWplY3RlZBIMCgRwYXRoGAEgASgJEg4KBnJlYXNvbhgCIAEoCSJiCglFZGl0RXJyb3ISDAoEcGF0aBgBIAEoCRINCgVlcnJvchgCIAEoCRIgChNtb2RlbF92aXNpYmxlX2Vycm9yGAUgASgJSACIAQFCFgoUX21vZGVsX3Zpc2libGVfZXJyb3IiVgoMRWRpdFRvb2xDYWxsEiAKBGFyZ3MYASABKAsyEi5hZ2VudC52MS5FZGl0QXJncxIkCgZyZXN1bHQYAiABKAsyFC5hZ2VudC52MS5FZGl0UmVzdWx0IjEKEUVkaXRUb29sQ2FsbERlbHRhEhwKFHN0cmVhbV9jb250ZW50X2RlbHRhGAEgASgJIjEKDEV4YUZldGNoQXJncxILCgNpZHMYASADKAkSFAoMdG9vbF9jYWxsX2lkGAIgASgJIqIBCg5FeGFGZXRjaFJlc3VsdBIsCgdzdWNjZXNzGAEgASgLMhkuYWdlbnQudjEuRXhhRmV0Y2hTdWNjZXNzSAASKAoFZXJyb3IYAiABKAsyFy5hZ2VudC52MS5FeGFGZXRjaEVycm9ySAASLgoIcmVqZWN0ZWQYAyABKAsyGi5hZ2VudC52MS5FeGFGZXRjaFJlamVjdGVkSABCCAoGcmVzdWx0Ij4KD0V4YUZldGNoU3VjY2VzcxIrCghjb250ZW50cxgBIAMoCzIZLmFnZW50LnYxLkV4YUZldGNoQ29udGVudCIeCg1FeGFGZXRjaEVycm9yEg0KBWVycm9yGAEgASgJIiIKEEV4YUZldGNoUmVqZWN0ZWQSDgoGcmVhc29uGAEgASgJIlMKD0V4YUZldGNoQ29udGVudBINCgV0aXRsZRgBIAEoCRILCgN1cmwYAiABKAkSDAoEdGV4dBgDIAEoCRIWCg5wdWJsaXNoZWRfZGF0ZRgEIAEoCSJiChBFeGFGZXRjaFRvb2xDYWxsEiQKBGFyZ3MYASABKAsyFi5hZ2VudC52MS5FeGFGZXRjaEFyZ3MSKAoGcmVzdWx0GAIgASgLMhguYWdlbnQudjEuRXhhRmV0Y2hSZXN1bHQiPAoURXhhRmV0Y2hSZXF1ZXN0UXVlcnkSJAoEYXJncxgBIAEoCzIWLmFnZW50LnYxLkV4YUZldGNoQXJncyKjAQoXRXhhRmV0Y2hSZXF1ZXN0UmVzcG9uc2USPgoIYXBwcm92ZWQYASABKAsyKi5hZ2VudC52MS5FeGFGZXRjaFJlcXVlc3RSZXNwb25zZV9BcHByb3ZlZEgAEj4KCHJlamVjdGVkGAIgASgLMiouYWdlbnQudjEuRXhhRmV0Y2hSZXF1ZXN0UmVzcG9uc2VfUmVqZWN0ZWRIAEIICgZyZXN1bHQiIgogRXhhRmV0Y2hSZXF1ZXN0UmVzcG9uc2VfQXBwcm92ZWQiMgogRXhhRmV0Y2hSZXF1ZXN0UmVzcG9uc2VfUmVqZWN0ZWQSDgoGcmVhc29uGAEgASgJIlcKDUV4YVNlYXJjaEFyZ3MSDQoFcXVlcnkYASABKAkSDAoEdHlwZRgCIAEoCRITCgtudW1fcmVzdWx0cxgDIAEoBRIUCgx0b29sX2NhbGxfaWQYBCABKAkipgEKD0V4YVNlYXJjaFJlc3VsdBItCgdzdWNjZXNzGAEgASgLMhouYWdlbnQudjEuRXhhU2VhcmNoU3VjY2Vzc0gAEikKBWVycm9yGAIgASgLMhguYWdlbnQudjEuRXhhU2VhcmNoRXJyb3JIABIvCghyZWplY3RlZBgDIAEoCzIbLmFnZW50LnYxLkV4YVNlYXJjaFJlamVjdGVkSABCCAoGcmVzdWx0IkQKEEV4YVNlYXJjaFN1Y2Nlc3MSMAoKcmVmZXJlbmNlcxgBIAMoCzIcLmFnZW50LnYxLkV4YVNlYXJjaFJlZmVyZW5jZSIfCg5FeGFTZWFyY2hFcnJvchINCgVlcnJvchgBIAEoCSIjChFFeGFTZWFyY2hSZWplY3RlZBIOCgZyZWFzb24YASABKAkiVgoSRXhhU2VhcmNoUmVmZXJlbmNlEg0KBXRpdGxlGAEgASgJEgsKA3VybBgCIAEoCRIMCgR0ZXh0GAMgASgJEhYKDnB1Ymxpc2hlZF9kYXRlGAQgASgJImUKEUV4YVNlYXJjaFRvb2xDYWxsEiUKBGFyZ3MYASABKAsyFy5hZ2VudC52MS5FeGFTZWFyY2hBcmdzEikKBnJlc3VsdBgCIAEoCzIZLmFnZW50LnYxLkV4YVNlYXJjaFJlc3VsdCI+ChVFeGFTZWFyY2hSZXF1ZXN0UXVlcnkSJQoEYXJncxgBIAEoCzIXLmFnZW50LnYxLkV4YVNlYXJjaEFyZ3MipgEKGEV4YVNlYXJjaFJlcXVlc3RSZXNwb25zZRI/CghhcHByb3ZlZBgBIAEoCzIrLmFnZW50LnYxLkV4YVNlYXJjaFJlcXVlc3RSZXNwb25zZV9BcHByb3ZlZEgAEj8KCHJlamVjdGVkGAIgASgLMisuYWdlbnQudjEuRXhhU2VhcmNoUmVxdWVzdFJlc3BvbnNlX1JlamVjdGVkSABCCAoGcmVzdWx0IiMKIUV4YVNlYXJjaFJlcXVlc3RSZXNwb25zZV9BcHByb3ZlZCIzCiFFeGFTZWFyY2hSZXF1ZXN0UmVzcG9uc2VfUmVqZWN0ZWQSDgoGcmVhc29uGAEgASgJIiMKFUV4ZWNDbGllbnRTdHJlYW1DbG9zZRIKCgJpZBgBIAEoDSJWCg9FeGVjQ2xpZW50VGhyb3cSCgoCaWQYASABKA0SDQoFZXJyb3IYAiABKAkSGAoLc3RhY2tfdHJhY2UYAyABKAlIAIgBAUIOCgxfc3RhY2tfdHJhY2UiIQoTRXhlY0NsaWVudEhlYXJ0YmVhdBIKCgJpZBgBIAEoDSK+AQoYRXhlY0NsaWVudENvbnRyb2xNZXNzYWdlEjcKDHN0cmVhbV9jbG9zZRgBIAEoCzIfLmFnZW50LnYxLkV4ZWNDbGllbnRTdHJlYW1DbG9zZUgAEioKBXRocm93GAIgASgLMhkuYWdlbnQudjEuRXhlY0NsaWVudFRocm93SAASMgoJaGVhcnRiZWF0GAMgASgLMh0uYWdlbnQudjEuRXhlY0NsaWVudEhlYXJ0YmVhdEgAQgkKB21lc3NhZ2UihAEKC1NwYW5Db250ZXh0EhAKCHRyYWNlX2lkGAEgASgJEg8KB3NwYW5faWQYAiABKAkSGAoLdHJhY2VfZmxhZ3MYAyABKA1IAIgBARIYCgt0cmFjZV9zdGF0ZRgEIAEoCUgBiAEBQg4KDF90cmFjZV9mbGFnc0IOCgxfdHJhY2Vfc3RhdGUiCwoJQWJvcnRBcmdzIg0KC0Fib3J0UmVzdWx0IoUIChFFeGVjU2VydmVyTWVzc2FnZRIKCgJpZBgBIAEoDRIPCgdleGVjX2lkGA8gASgJEjAKDHNwYW5fY29udGV4dBgTIAEoCzIVLmFnZW50LnYxLlNwYW5Db250ZXh0SAGIAQESKQoKc2hlbGxfYXJncxgCIAEoCzITLmFnZW50LnYxLlNoZWxsQXJnc0gAEikKCndyaXRlX2FyZ3MYAyABKAsyEy5hZ2VudC52MS5Xcml0ZUFyZ3NIABIrCgtkZWxldGVfYXJncxgEIAEoCzIULmFnZW50LnYxLkRlbGV0ZUFyZ3NIABInCglncmVwX2FyZ3MYBSABKAsyEi5hZ2VudC52MS5HcmVwQXJnc0gAEicKCXJlYWRfYXJncxgHIAEoCzISLmFnZW50LnYxLlJlYWRBcmdzSAASIwoHbHNfYXJncxgIIAEoCzIQLmFnZW50LnYxLkxzQXJnc0gAEjUKEGRpYWdub3N0aWNzX2FyZ3MYCSABKAsyGS5hZ2VudC52MS5EaWFnbm9zdGljc0FyZ3NIABI8ChRyZXF1ZXN0X2NvbnRleHRfYXJncxgKIAEoCzIcLmFnZW50LnYxLlJlcXVlc3RDb250ZXh0QXJnc0gAEiUKCG1jcF9hcmdzGAsgASgLMhEuYWdlbnQudjEuTWNwQXJnc0gAEjAKEXNoZWxsX3N0cmVhbV9hcmdzGA4gASgLMhMuYWdlbnQudjEuU2hlbGxBcmdzSAASSQobYmFja2dyb3VuZF9zaGVsbF9zcGF3bl9hcmdzGBAgASgLMiIuYWdlbnQudjEuQmFja2dyb3VuZFNoZWxsU3Bhd25BcmdzSAASSgocbGlzdF9tY3BfcmVzb3VyY2VzX2V4ZWNfYXJncxgRIAEoCzIiLmFnZW50LnYxLkxpc3RNY3BSZXNvdXJjZXNFeGVjQXJnc0gAEkgKG3JlYWRfbWNwX3Jlc291cmNlX2V4ZWNfYXJncxgSIAEoCzIhLmFnZW50LnYxLlJlYWRNY3BSZXNvdXJjZUV4ZWNBcmdzSAASKQoKZmV0Y2hfYXJncxgUIAEoCzITLmFnZW50LnYxLkZldGNoQXJnc0gAEjgKEnJlY29yZF9zY3JlZW5fYXJncxgVIAEoCzIaLmFnZW50LnYxLlJlY29yZFNjcmVlbkFyZ3NIABI2ChFjb21wdXRlcl91c2VfYXJncxgWIAEoCzIZLmFnZW50LnYxLkNvbXB1dGVyVXNlQXJnc0gAEj8KFndyaXRlX3NoZWxsX3N0ZGluX2FyZ3MYFyABKAsyHS5hZ2VudC52MS5Xcml0ZVNoZWxsU3RkaW5BcmdzSABCCQoHbWVzc2FnZUIPCg1fc3Bhbl9jb250ZXh0Iv8HChFFeGVjQ2xpZW50TWVzc2FnZRIKCgJpZBgBIAEoDRIPCgdleGVjX2lkGA8gASgJEi0KDHNoZWxsX3Jlc3VsdBgCIAEoCzIVLmFnZW50LnYxLlNoZWxsUmVzdWx0SAASLQoMd3JpdGVfcmVzdWx0GAMgASgLMhUuYWdlbnQudjEuV3JpdGVSZXN1bHRIABIvCg1kZWxldGVfcmVzdWx0GAQgASgLMhYuYWdlbnQudjEuRGVsZXRlUmVzdWx0SAASKwoLZ3JlcF9yZXN1bHQYBSABKAsyFC5hZ2VudC52MS5HcmVwUmVzdWx0SAASKwoLcmVhZF9yZXN1bHQYByABKAsyFC5hZ2VudC52MS5SZWFkUmVzdWx0SAASJwoJbHNfcmVzdWx0GAggASgLMhIuYWdlbnQudjEuTHNSZXN1bHRIABI5ChJkaWFnbm9zdGljc19yZXN1bHQYCSABKAsyGy5hZ2VudC52MS5EaWFnbm9zdGljc1Jlc3VsdEgAEkAKFnJlcXVlc3RfY29udGV4dF9yZXN1bHQYCiABKAsyHi5hZ2VudC52MS5SZXF1ZXN0Q29udGV4dFJlc3VsdEgAEikKCm1jcF9yZXN1bHQYCyABKAsyEy5hZ2VudC52MS5NY3BSZXN1bHRIABItCgxzaGVsbF9zdHJlYW0YDiABKAsyFS5hZ2VudC52MS5TaGVsbFN0cmVhbUgAEk0KHWJhY2tncm91bmRfc2hlbGxfc3Bhd25fcmVzdWx0GBAgASgLMiQuYWdlbnQudjEuQmFja2dyb3VuZFNoZWxsU3Bhd25SZXN1bHRIABJOCh5saXN0X21jcF9yZXNvdXJjZXNfZXhlY19yZXN1bHQYESABKAsyJC5hZ2VudC52MS5MaXN0TWNwUmVzb3VyY2VzRXhlY1Jlc3VsdEgAEkwKHXJlYWRfbWNwX3Jlc291cmNlX2V4ZWNfcmVzdWx0GBIgASgLMiMuYWdlbnQudjEuUmVhZE1jcFJlc291cmNlRXhlY1Jlc3VsdEgAEi0KDGZldGNoX3Jlc3VsdBgUIAEoCzIVLmFnZW50LnYxLkZldGNoUmVzdWx0SAASPAoUcmVjb3JkX3NjcmVlbl9yZXN1bHQYFSABKAsyHC5hZ2VudC52MS5SZWNvcmRTY3JlZW5SZXN1bHRIABI6ChNjb21wdXRlcl91c2VfcmVzdWx0GBYgASgLMhsuYWdlbnQudjEuQ29tcHV0ZXJVc2VSZXN1bHRIABJDChh3cml0ZV9zaGVsbF9zdGRpbl9yZXN1bHQYFyABKAsyHy5hZ2VudC52MS5Xcml0ZVNoZWxsU3RkaW5SZXN1bHRIAEIJCgdtZXNzYWdlIi4KCUZldGNoQXJncxILCgN1cmwYASABKAkSFAoMdG9vbF9jYWxsX2lkGAIgASgJImkKC0ZldGNoUmVzdWx0EikKB3N1Y2Nlc3MYASABKAsyFi5hZ2VudC52MS5GZXRjaFN1Y2Nlc3NIABIlCgVlcnJvchgCIAEoCzIULmFnZW50LnYxLkZldGNoRXJyb3JIAEIICgZyZXN1bHQiVwoMRmV0Y2hTdWNjZXNzEgsKA3VybBgBIAEoCRIPCgdjb250ZW50GAIgASgJEhMKC3N0YXR1c19jb2RlGAMgASgFEhQKDGNvbnRlbnRfdHlwZRgEIAEoCSIoCgpGZXRjaEVycm9yEgsKA3VybBgBIAEoCRINCgVlcnJvchgCIAEoCSJtChFHZW5lcmF0ZUltYWdlQXJncxITCgtkZXNjcmlwdGlvbhgBIAEoCRIWCglmaWxlX3BhdGgYAiABKAlIAIgBARIdChVyZWZlcmVuY2VfaW1hZ2VfcGF0aHMYBSADKAlCDAoKX2ZpbGVfcGF0aCKBAQoTR2VuZXJhdGVJbWFnZVJlc3VsdBIxCgdzdWNjZXNzGAEgASgLMh4uYWdlbnQudjEuR2VuZXJhdGVJbWFnZVN1Y2Nlc3NIABItCgVlcnJvchgCIAEoCzIcLmFnZW50LnYxLkdlbmVyYXRlSW1hZ2VFcnJvckgAQggKBnJlc3VsdCI9ChRHZW5lcmF0ZUltYWdlU3VjY2VzcxIRCglmaWxlX3BhdGgYASABKAkSEgoKaW1hZ2VfZGF0YRgCIAEoCSIjChJHZW5lcmF0ZUltYWdlRXJyb3ISDQoFZXJyb3IYASABKAkicQoVR2VuZXJhdGVJbWFnZVRvb2xDYWxsEikKBGFyZ3MYASABKAsyGy5hZ2VudC52MS5HZW5lcmF0ZUltYWdlQXJncxItCgZyZXN1bHQYAiABKAsyHS5hZ2VudC52MS5HZW5lcmF0ZUltYWdlUmVzdWx0IsYECghHcmVwQXJncxIPCgdwYXR0ZXJuGAEgASgJEhEKBHBhdGgYAiABKAlIAIgBARIRCgRnbG9iGAMgASgJSAGIAQESGAoLb3V0cHV0X21vZGUYBCABKAlIAogBARIbCg5jb250ZXh0X2JlZm9yZRgFIAEoBUgDiAEBEhoKDWNvbnRleHRfYWZ0ZXIYBiABKAVIBIgBARIUCgdjb250ZXh0GAcgASgFSAWIAQESHQoQY2FzZV9pbnNlbnNpdGl2ZRgIIAEoCEgGiAEBEhEKBHR5cGUYCSABKAlIB4gBARIXCgpoZWFkX2xpbWl0GAogASgFSAiIAQESFgoJbXVsdGlsaW5lGAsgASgISAmIAQESEQoEc29ydBgMIAEoCUgKiAEBEhsKDnNvcnRfYXNjZW5kaW5nGA0gASgISAuIAQESFAoMdG9vbF9jYWxsX2lkGA4gASgJEjQKDnNhbmRib3hfcG9saWN5GA8gASgLMhcuYWdlbnQudjEuU2FuZGJveFBvbGljeUgMiAEBQgcKBV9wYXRoQgcKBV9nbG9iQg4KDF9vdXRwdXRfbW9kZUIRCg9fY29udGV4dF9iZWZvcmVCEAoOX2NvbnRleHRfYWZ0ZXJCCgoIX2NvbnRleHRCEwoRX2Nhc2VfaW5zZW5zaXRpdmVCBwoFX3R5cGVCDQoLX2hlYWRfbGltaXRCDAoKX211bHRpbGluZUIHCgVfc29ydEIRCg9fc29ydF9hc2NlbmRpbmdCEQoPX3NhbmRib3hfcG9saWN5ImYKCkdyZXBSZXN1bHQSKAoHc3VjY2VzcxgBIAEoCzIVLmFnZW50LnYxLkdyZXBTdWNjZXNzSAASJAoFZXJyb3IYAiABKAsyEy5hZ2VudC52MS5HcmVwRXJyb3JIAEIICgZyZXN1bHQiGgoJR3JlcEVycm9yEg0KBWVycm9yGAEgASgJIrQCCgtHcmVwU3VjY2VzcxIPCgdwYXR0ZXJuGAEgASgJEgwKBHBhdGgYAiABKAkSEwoLb3V0cHV0X21vZGUYAyABKAkSRgoRd29ya3NwYWNlX3Jlc3VsdHMYBCADKAsyKy5hZ2VudC52MS5HcmVwU3VjY2Vzcy5Xb3Jrc3BhY2VSZXN1bHRzRW50cnkSPAoUYWN0aXZlX2VkaXRvcl9yZXN1bHQYBSABKAsyGS5hZ2VudC52MS5HcmVwVW5pb25SZXN1bHRIAIgBARpSChVXb3Jrc3BhY2VSZXN1bHRzRW50cnkSCwoDa2V5GAEgASgJEigKBXZhbHVlGAIgASgLMhkuYWdlbnQudjEuR3JlcFVuaW9uUmVzdWx0OgI4AUIXChVfYWN0aXZlX2VkaXRvcl9yZXN1bHQiowEKD0dyZXBVbmlvblJlc3VsdBIqCgVjb3VudBgBIAEoCzIZLmFnZW50LnYxLkdyZXBDb3VudFJlc3VsdEgAEioKBWZpbGVzGAIgASgLMhkuYWdlbnQudjEuR3JlcEZpbGVzUmVzdWx0SAASLgoHY29udGVudBgDIAEoCzIbLmFnZW50LnYxLkdyZXBDb250ZW50UmVzdWx0SABCCAoGcmVzdWx0IpsBCg9HcmVwQ291bnRSZXN1bHQSJwoGY291bnRzGAEgAygLMhcuYWdlbnQudjEuR3JlcEZpbGVDb3VudBITCgt0b3RhbF9maWxlcxgCIAEoBRIVCg10b3RhbF9tYXRjaGVzGAMgASgFEhgKEGNsaWVudF90cnVuY2F0ZWQYBCABKAgSGQoRcmlwZ3JlcF90cnVuY2F0ZWQYBSABKAgiLAoNR3JlcEZpbGVDb3VudBIMCgRmaWxlGAEgASgJEg0KBWNvdW50GAIgASgFImoKD0dyZXBGaWxlc1Jlc3VsdBINCgVmaWxlcxgBIAMoCRITCgt0b3RhbF9maWxlcxgCIAEoBRIYChBjbGllbnRfdHJ1bmNhdGVkGAMgASgIEhkKEXJpcGdyZXBfdHJ1bmNhdGVkGAQgASgIIqQBChFHcmVwQ29udGVudFJlc3VsdBIoCgdtYXRjaGVzGAEgAygLMhcuYWdlbnQudjEuR3JlcEZpbGVNYXRjaBITCgt0b3RhbF9saW5lcxgCIAEoBRIbChN0b3RhbF9tYXRjaGVkX2xpbmVzGAMgASgFEhgKEGNsaWVudF90cnVuY2F0ZWQYBCABKAgSGQoRcmlwZ3JlcF90cnVuY2F0ZWQYBSABKAgiSgoNR3JlcEZpbGVNYXRjaBIMCgRmaWxlGAEgASgJEisKB21hdGNoZXMYAiADKAsyGi5hZ2VudC52MS5HcmVwQ29udGVudE1hdGNoImwKEEdyZXBDb250ZW50TWF0Y2gSEwoLbGluZV9udW1iZXIYASABKAUSDwoHY29udGVudBgCIAEoCRIZChFjb250ZW50X3RydW5jYXRlZBgDIAEoCBIXCg9pc19jb250ZXh0X2xpbmUYBCABKAgiHQoKR3JlcFN0cmVhbRIPCgdwYXR0ZXJuGAEgASgJIlYKDEdyZXBUb29sQ2FsbBIgCgRhcmdzGAEgASgLMhIuYWdlbnQudjEuR3JlcEFyZ3MSJAoGcmVzdWx0GAIgASgLMhQuYWdlbnQudjEuR3JlcFJlc3VsdCIeCgtHZXRCbG9iQXJncxIPCgdibG9iX2lkGAEgASgMIjUKDUdldEJsb2JSZXN1bHQSFgoJYmxvYl9kYXRhGAEgASgMSACIAQFCDAoKX2Jsb2JfZGF0YSIxCgtTZXRCbG9iQXJncxIPCgdibG9iX2lkGAEgASgMEhEKCWJsb2JfZGF0YRgCIAEoDCI+Cg1TZXRCbG9iUmVzdWx0EiMKBWVycm9yGAEgASgLMg8uYWdlbnQudjEuRXJyb3JIAIgBAUIICgZfZXJyb3IiywEKD0t2U2VydmVyTWVzc2FnZRIKCgJpZBgBIAEoDRIwCgxzcGFuX2NvbnRleHQYBCABKAsyFS5hZ2VudC52MS5TcGFuQ29udGV4dEgBiAEBEi4KDWdldF9ibG9iX2FyZ3MYAiABKAsyFS5hZ2VudC52MS5HZXRCbG9iQXJnc0gAEi4KDXNldF9ibG9iX2FyZ3MYAyABKAsyFS5hZ2VudC52MS5TZXRCbG9iQXJnc0gAQgkKB21lc3NhZ2VCDwoNX3NwYW5fY29udGV4dCKQAQoPS3ZDbGllbnRNZXNzYWdlEgoKAmlkGAEgASgNEjIKD2dldF9ibG9iX3Jlc3VsdBgCIAEoCzIXLmFnZW50LnYxLkdldEJsb2JSZXN1bHRIABIyCg9zZXRfYmxvYl9yZXN1bHQYAyABKAsyFy5hZ2VudC52MS5TZXRCbG9iUmVzdWx0SABCCQoHbWVzc2FnZSKtAQoGTHNBcmdzEgwKBHBhdGgYASABKAkSDgoGaWdub3JlGAIgAygJEhQKDHRvb2xfY2FsbF9pZBgDIAEoCRI0Cg5zYW5kYm94X3BvbGljeRgEIAEoCzIXLmFnZW50LnYxLlNhbmRib3hQb2xpY3lIAIgBARIXCgp0aW1lb3V0X21zGAUgASgNSAGIAQFCEQoPX3NhbmRib3hfcG9saWN5Qg0KC190aW1lb3V0X21zIrIBCghMc1Jlc3VsdBImCgdzdWNjZXNzGAEgASgLMhMuYWdlbnQudjEuTHNTdWNjZXNzSAASIgoFZXJyb3IYAiABKAsyES5hZ2VudC52MS5Mc0Vycm9ySAASKAoIcmVqZWN0ZWQYAyABKAsyFC5hZ2VudC52MS5Mc1JlamVjdGVkSAASJgoHdGltZW91dBgEIAEoCzITLmFnZW50LnYxLkxzVGltZW91dEgAQggKBnJlc3VsdCJHCglMc1N1Y2Nlc3MSOgoTZGlyZWN0b3J5X3RyZWVfcm9vdBgBIAEoCzIdLmFnZW50LnYxLkxzRGlyZWN0b3J5VHJlZU5vZGUi9gIKE0xzRGlyZWN0b3J5VHJlZU5vZGUSEAoIYWJzX3BhdGgYASABKAkSNAoNY2hpbGRyZW5fZGlycxgCIAMoCzIdLmFnZW50LnYxLkxzRGlyZWN0b3J5VHJlZU5vZGUSOgoOY2hpbGRyZW5fZmlsZXMYAyADKAsyIi5hZ2VudC52MS5Mc0RpcmVjdG9yeVRyZWVOb2RlX0ZpbGUSHwoXY2hpbGRyZW5fd2VyZV9wcm9jZXNzZWQYBCABKAgSZAodZnVsbF9zdWJ0cmVlX2V4dGVuc2lvbl9jb3VudHMYBSADKAsyPS5hZ2VudC52MS5Mc0RpcmVjdG9yeVRyZWVOb2RlLkZ1bGxTdWJ0cmVlRXh0ZW5zaW9uQ291bnRzRW50cnkSEQoJbnVtX2ZpbGVzGAYgASgFGkEKH0Z1bGxTdWJ0cmVlRXh0ZW5zaW9uQ291bnRzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgFOgI4ASJ6ChhMc0RpcmVjdG9yeVRyZWVOb2RlX0ZpbGUSDAoEbmFtZRgBIAEoCRI6ChF0ZXJtaW5hbF9tZXRhZGF0YRgCIAEoCzIaLmFnZW50LnYxLlRlcm1pbmFsTWV0YWRhdGFIAIgBAUIUChJfdGVybWluYWxfbWV0YWRhdGEiJgoHTHNFcnJvchIMCgRwYXRoGAEgASgJEg0KBWVycm9yGAIgASgJIioKCkxzUmVqZWN0ZWQSDAoEcGF0aBgBIAEoCRIOCgZyZWFzb24YAiABKAkiRwoJTHNUaW1lb3V0EjoKE2RpcmVjdG9yeV90cmVlX3Jvb3QYASABKAsyHS5hZ2VudC52MS5Mc0RpcmVjdG9yeVRyZWVOb2RlIvEBChBUZXJtaW5hbE1ldGFkYXRhEhAKA2N3ZBgBIAEoCUgAiAEBEjkKDWxhc3RfY29tbWFuZHMYAiADKAsyIi5hZ2VudC52MS5UZXJtaW5hbE1ldGFkYXRhX0NvbW1hbmQSHQoQbGFzdF9tb2RpZmllZF9tcxgDIAEoA0gBiAEBEkAKD2N1cnJlbnRfY29tbWFuZBgEIAEoCzIiLmFnZW50LnYxLlRlcm1pbmFsTWV0YWRhdGFfQ29tbWFuZEgCiAEBQgYKBF9jd2RCEwoRX2xhc3RfbW9kaWZpZWRfbXNCEgoQX2N1cnJlbnRfY29tbWFuZCKnAQoYVGVybWluYWxNZXRhZGF0YV9Db21tYW5kEg8KB2NvbW1hbmQYASABKAkSFgoJZXhpdF9jb2RlGAIgASgFSACIAQESGQoMdGltZXN0YW1wX21zGAMgASgDSAGIAQESGAoLZHVyYXRpb25fbXMYBCABKANIAogBAUIMCgpfZXhpdF9jb2RlQg8KDV90aW1lc3RhbXBfbXNCDgoMX2R1cmF0aW9uX21zIlAKCkxzVG9vbENhbGwSHgoEYXJncxgBIAEoCzIQLmFnZW50LnYxLkxzQXJncxIiCgZyZXN1bHQYAiABKAsyEi5hZ2VudC52MS5Mc1Jlc3VsdCK1AQoHTWNwQXJncxIMCgRuYW1lGAEgASgJEikKBGFyZ3MYAiADKAsyGy5hZ2VudC52MS5NY3BBcmdzLkFyZ3NFbnRyeRIUCgx0b29sX2NhbGxfaWQYAyABKAkSGwoTcHJvdmlkZXJfaWRlbnRpZmllchgEIAEoCRIRCgl0b29sX25hbWUYBSABKAkaKwoJQXJnc0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoDDoCOAEi/wEKCU1jcFJlc3VsdBInCgdzdWNjZXNzGAEgASgLMhQuYWdlbnQudjEuTWNwU3VjY2Vzc0gAEiMKBWVycm9yGAIgASgLMhIuYWdlbnQudjEuTWNwRXJyb3JIABIpCghyZWplY3RlZBgDIAEoCzIVLmFnZW50LnYxLk1jcFJlamVjdGVkSAASOgoRcGVybWlzc2lvbl9kZW5pZWQYBCABKAsyHS5hZ2VudC52MS5NY3BQZXJtaXNzaW9uRGVuaWVkSAASMwoOdG9vbF9ub3RfZm91bmQYBSABKAsyGS5hZ2VudC52MS5NY3BUb29sTm90Rm91bmRIAEIICgZyZXN1bHQiOAoPTWNwVG9vbE5vdEZvdW5kEgwKBG5hbWUYASABKAkSFwoPYXZhaWxhYmxlX3Rvb2xzGAIgAygJImoKDk1jcFRleHRDb250ZW50EgwKBHRleHQYASABKAkSNgoPb3V0cHV0X2xvY2F0aW9uGAIgASgLMhguYWdlbnQudjEuT3V0cHV0TG9jYXRpb25IAIgBAUISChBfb3V0cHV0X2xvY2F0aW9uIjIKD01jcEltYWdlQ29udGVudBIMCgRkYXRhGAEgASgMEhEKCW1pbWVfdHlwZRgCIAEoCSJ7ChhNY3BUb29sUmVzdWx0Q29udGVudEl0ZW0SKAoEdGV4dBgBIAEoCzIYLmFnZW50LnYxLk1jcFRleHRDb250ZW50SAASKgoFaW1hZ2UYAiABKAsyGS5hZ2VudC52MS5NY3BJbWFnZUNvbnRlbnRIAEIJCgdjb250ZW50IlMKCk1jcFN1Y2Nlc3MSMwoHY29udGVudBgBIAMoCzIiLmFnZW50LnYxLk1jcFRvb2xSZXN1bHRDb250ZW50SXRlbRIQCghpc19lcnJvchgCIAEoCCIZCghNY3BFcnJvchINCgVlcnJvchgBIAEoCSIyCgtNY3BSZWplY3RlZBIOCgZyZWFzb24YASABKAkSEwoLaXNfcmVhZG9ubHkYAiABKAgiOQoTTWNwUGVybWlzc2lvbkRlbmllZBINCgVlcnJvchgBIAEoCRITCgtpc19yZWFkb25seRgCIAEoCCI6ChhMaXN0TWNwUmVzb3VyY2VzRXhlY0FyZ3MSEwoGc2VydmVyGAEgASgJSACIAQFCCQoHX3NlcnZlciLGAQoaTGlzdE1jcFJlc291cmNlc0V4ZWNSZXN1bHQSNAoHc3VjY2VzcxgBIAEoCzIhLmFnZW50LnYxLkxpc3RNY3BSZXNvdXJjZXNTdWNjZXNzSAASMAoFZXJyb3IYAiABKAsyHy5hZ2VudC52MS5MaXN0TWNwUmVzb3VyY2VzRXJyb3JIABI2CghyZWplY3RlZBgDIAEoCzIiLmFnZW50LnYxLkxpc3RNY3BSZXNvdXJjZXNSZWplY3RlZEgAQggKBnJlc3VsdCK9AgomTGlzdE1jcFJlc291cmNlc0V4ZWNSZXN1bHRfTWNwUmVzb3VyY2USCwoDdXJpGAEgASgJEhEKBG5hbWUYAiABKAlIAIgBARIYCgtkZXNjcmlwdGlvbhgDIAEoCUgBiAEBEhYKCW1pbWVfdHlwZRgEIAEoCUgCiAEBEg4KBnNlcnZlchgFIAEoCRJWCgthbm5vdGF0aW9ucxgGIAMoCzJBLmFnZW50LnYxLkxpc3RNY3BSZXNvdXJjZXNFeGVjUmVzdWx0X01jcFJlc291cmNlLkFubm90YXRpb25zRW50cnkaMgoQQW5ub3RhdGlvbnNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBQgcKBV9uYW1lQg4KDF9kZXNjcmlwdGlvbkIMCgpfbWltZV90eXBlIl4KF0xpc3RNY3BSZXNvdXJjZXNTdWNjZXNzEkMKCXJlc291cmNlcxgBIAMoCzIwLmFnZW50LnYxLkxpc3RNY3BSZXNvdXJjZXNFeGVjUmVzdWx0X01jcFJlc291cmNlIiYKFUxpc3RNY3BSZXNvdXJjZXNFcnJvchINCgVlcnJvchgBIAEoCSIqChhMaXN0TWNwUmVzb3VyY2VzUmVqZWN0ZWQSDgoGcmVhc29uGAEgASgJImQKF1JlYWRNY3BSZXNvdXJjZUV4ZWNBcmdzEg4KBnNlcnZlchgBIAEoCRILCgN1cmkYAiABKAkSGgoNZG93bmxvYWRfcGF0aBgDIAEoCUgAiAEBQhAKDl9kb3dubG9hZF9wYXRoIvoBChlSZWFkTWNwUmVzb3VyY2VFeGVjUmVzdWx0EjMKB3N1Y2Nlc3MYASABKAsyIC5hZ2VudC52MS5SZWFkTWNwUmVzb3VyY2VTdWNjZXNzSAASLwoFZXJyb3IYAiABKAsyHi5hZ2VudC52MS5SZWFkTWNwUmVzb3VyY2VFcnJvckgAEjUKCHJlamVjdGVkGAMgASgLMiEuYWdlbnQudjEuUmVhZE1jcFJlc291cmNlUmVqZWN0ZWRIABI2Cglub3RfZm91bmQYBCABKAsyIS5hZ2VudC52MS5SZWFkTWNwUmVzb3VyY2VOb3RGb3VuZEgAQggKBnJlc3VsdCLmAgoWUmVhZE1jcFJlc291cmNlU3VjY2VzcxILCgN1cmkYASABKAkSEQoEbmFtZRgCIAEoCUgBiAEBEhgKC2Rlc2NyaXB0aW9uGAMgASgJSAKIAQESFgoJbWltZV90eXBlGAQgASgJSAOIAQESRgoLYW5ub3RhdGlvbnMYByADKAsyMS5hZ2VudC52MS5SZWFkTWNwUmVzb3VyY2VTdWNjZXNzLkFubm90YXRpb25zRW50cnkSGgoNZG93bmxvYWRfcGF0aBgIIAEoCUgEiAEBEg4KBHRleHQYBSABKAlIABIOCgRibG9iGAYgASgMSAAaMgoQQW5ub3RhdGlvbnNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBQgkKB2NvbnRlbnRCBwoFX25hbWVCDgoMX2Rlc2NyaXB0aW9uQgwKCl9taW1lX3R5cGVCEAoOX2Rvd25sb2FkX3BhdGgiMgoUUmVhZE1jcFJlc291cmNlRXJyb3ISCwoDdXJpGAEgASgJEg0KBWVycm9yGAIgASgJIjYKF1JlYWRNY3BSZXNvdXJjZVJlamVjdGVkEgsKA3VyaRgBIAEoCRIOCgZyZWFzb24YAiABKAkiJgoXUmVhZE1jcFJlc291cmNlTm90Rm91bmQSCwoDdXJpGAEgASgJInwKEU1jcFRvb2xEZWZpbml0aW9uEgwKBG5hbWUYASABKAkSGwoTcHJvdmlkZXJfaWRlbnRpZmllchgEIAEoCRIRCgl0b29sX25hbWUYBSABKAkSEwoLZGVzY3JpcHRpb24YAiABKAkSFAoMaW5wdXRfc2NoZW1hGAMgASgMIjoKCE1jcFRvb2xzEi4KCW1jcF90b29scxgBIAMoCzIbLmFnZW50LnYxLk1jcFRvb2xEZWZpbml0aW9uIjwKD01jcEluc3RydWN0aW9ucxITCgtzZXJ2ZXJfbmFtZRgBIAEoCRIUCgxpbnN0cnVjdGlvbnMYAiABKAki1wEKDU1jcERlc2NyaXB0b3ISEwoLc2VydmVyX25hbWUYASABKAkSGQoRc2VydmVyX2lkZW50aWZpZXIYAiABKAkSGAoLZm9sZGVyX3BhdGgYAyABKAlIAIgBARIkChdzZXJ2ZXJfdXNlX2luc3RydWN0aW9ucxgEIAEoCUgBiAEBEioKBXRvb2xzGAUgAygLMhsuYWdlbnQudjEuTWNwVG9vbERlc2NyaXB0b3JCDgoMX2ZvbGRlcl9wYXRoQhoKGF9zZXJ2ZXJfdXNlX2luc3RydWN0aW9ucyJYChFNY3BUb29sRGVzY3JpcHRvchIRCgl0b29sX25hbWUYASABKAkSHAoPZGVmaW5pdGlvbl9wYXRoGAIgASgJSACIAQFCEgoQX2RlZmluaXRpb25fcGF0aCJ4ChRNY3BGaWxlU3lzdGVtT3B0aW9ucxIPCgdlbmFibGVkGAEgASgIEh0KFXdvcmtzcGFjZV9wcm9qZWN0X2RpchgCIAEoCRIwCg9tY3BfZGVzY3JpcHRvcnMYAyADKAsyFy5hZ2VudC52MS5NY3BEZXNjcmlwdG9yIi4KCFJlYWRBcmdzEgwKBHBhdGgYASABKAkSFAoMdG9vbF9jYWxsX2lkGAIgASgJIrgCCgpSZWFkUmVzdWx0EigKB3N1Y2Nlc3MYASABKAsyFS5hZ2VudC52MS5SZWFkU3VjY2Vzc0gAEiQKBWVycm9yGAIgASgLMhMuYWdlbnQudjEuUmVhZEVycm9ySAASKgoIcmVqZWN0ZWQYAyABKAsyFi5hZ2VudC52MS5SZWFkUmVqZWN0ZWRIABI0Cg5maWxlX25vdF9mb3VuZBgEIAEoCzIaLmFnZW50LnYxLlJlYWRGaWxlTm90Rm91bmRIABI7ChFwZXJtaXNzaW9uX2RlbmllZBgFIAEoCzIeLmFnZW50LnYxLlJlYWRQZXJtaXNzaW9uRGVuaWVkSAASMQoMaW52YWxpZF9maWxlGAYgASgLMhkuYWdlbnQudjEuUmVhZEludmFsaWRGaWxlSABCCAoGcmVzdWx0IrMBCgtSZWFkU3VjY2VzcxIMCgRwYXRoGAEgASgJEhMKC3RvdGFsX2xpbmVzGAMgASgFEhEKCWZpbGVfc2l6ZRgEIAEoAxIRCgl0cnVuY2F0ZWQYBiABKAgSGwoOb3V0cHV0X2Jsb2JfaWQYByABKAxIAYgBARIRCgdjb250ZW50GAIgASgJSAASDgoEZGF0YRgFIAEoDEgAQggKBm91dHB1dEIRCg9fb3V0cHV0X2Jsb2JfaWQiKAoJUmVhZEVycm9yEgwKBHBhdGgYASABKAkSDQoFZXJyb3IYAiABKAkiLAoMUmVhZFJlamVjdGVkEgwKBHBhdGgYASABKAkSDgoGcmVhc29uGAIgASgJIiAKEFJlYWRGaWxlTm90Rm91bmQSDAoEcGF0aBgBIAEoCSIkChRSZWFkUGVybWlzc2lvbkRlbmllZBIMCgRwYXRoGAEgASgJIi8KD1JlYWRJbnZhbGlkRmlsZRIMCgRwYXRoGAEgASgJEg4KBnJlYXNvbhgCIAEoCSJeCgxSZWFkVG9vbENhbGwSJAoEYXJncxgBIAEoCzIWLmFnZW50LnYxLlJlYWRUb29sQXJncxIoCgZyZXN1bHQYAiABKAsyGC5hZ2VudC52MS5SZWFkVG9vbFJlc3VsdCJaCgxSZWFkVG9vbEFyZ3MSDAoEcGF0aBgBIAEoCRITCgZvZmZzZXQYAiABKAVIAIgBARISCgVsaW1pdBgDIAEoBUgBiAEBQgkKB19vZmZzZXRCCAoGX2xpbWl0InIKDlJlYWRUb29sUmVzdWx0EiwKB3N1Y2Nlc3MYASABKAsyGS5hZ2VudC52MS5SZWFkVG9vbFN1Y2Nlc3NIABIoCgVlcnJvchgCIAEoCzIXLmFnZW50LnYxLlJlYWRUb29sRXJyb3JIAEIICgZyZXN1bHQiMQoJUmVhZFJhbmdlEhIKCnN0YXJ0X2xpbmUYASABKA0SEAoIZW5kX2xpbmUYAiABKA0ijgIKD1JlYWRUb29sU3VjY2VzcxIQCghpc19lbXB0eRgCIAEoCBIWCg5leGNlZWRlZF9saW1pdBgDIAEoCBITCgt0b3RhbF9saW5lcxgEIAEoDRIRCglmaWxlX3NpemUYBSABKA0SDAoEcGF0aBgHIAEoCRIsCgpyZWFkX3JhbmdlGAggASgLMhMuYWdlbnQudjEuUmVhZFJhbmdlSAGIAQESEQoHY29udGVudBgBIAEoCUgAEg4KBGRhdGEYBiABKAxIABIWCgxkYXRhX2Jsb2JfaWQYCSABKAxIABIZCg9jb250ZW50X2Jsb2JfaWQYCiABKAxIAEIICgZvdXRwdXRCDQoLX3JlYWRfcmFuZ2UiJgoNUmVhZFRvb2xFcnJvchIVCg1lcnJvcl9tZXNzYWdlGAEgASgJImoKEFJlY29yZFNjcmVlbkFyZ3MSDAoEbW9kZRgBIAEoBRIUCgx0b29sX2NhbGxfaWQYAiABKAkSHQoQc2F2ZV9hc19maWxlbmFtZRgDIAEoCUgAiAEBQhMKEV9zYXZlX2FzX2ZpbGVuYW1lIokCChJSZWNvcmRTY3JlZW5SZXN1bHQSOwoNc3RhcnRfc3VjY2VzcxgBIAEoCzIiLmFnZW50LnYxLlJlY29yZFNjcmVlblN0YXJ0U3VjY2Vzc0gAEjkKDHNhdmVfc3VjY2VzcxgCIAEoCzIhLmFnZW50LnYxLlJlY29yZFNjcmVlblNhdmVTdWNjZXNzSAASPwoPZGlzY2FyZF9zdWNjZXNzGAMgASgLMiQuYWdlbnQudjEuUmVjb3JkU2NyZWVuRGlzY2FyZFN1Y2Nlc3NIABIwCgdmYWlsdXJlGAQgASgLMh0uYWdlbnQudjEuUmVjb3JkU2NyZWVuRmFpbHVyZUgAQggKBnJlc3VsdCJnChhSZWNvcmRTY3JlZW5TdGFydFN1Y2Nlc3MSJQodd2FzX3ByaW9yX3JlY29yZGluZ19jYW5jZWxsZWQYASABKAgSJAocd2FzX3NhdmVfYXNfZmlsZW5hbWVfaWdub3JlZBgCIAEoCCKgAQoXUmVjb3JkU2NyZWVuU2F2ZVN1Y2Nlc3MSDAoEcGF0aBgBIAEoCRIdChVyZWNvcmRpbmdfZHVyYXRpb25fbXMYAiABKAMSMAojcmVxdWVzdGVkX2ZpbGVfcGF0aF9yZWplY3RlZF9yZWFzb24YAyABKAVIAIgBAUImCiRfcmVxdWVzdGVkX2ZpbGVfcGF0aF9yZWplY3RlZF9yZWFzb24iHAoaUmVjb3JkU2NyZWVuRGlzY2FyZFN1Y2Nlc3MiJAoTUmVjb3JkU2NyZWVuRmFpbHVyZRINCgVlcnJvchgBIAEoCSI2ChNDdXJzb3JQYWNrYWdlUHJvbXB0EgwKBG5hbWUYASABKAkSEQoJZmlsZV9wYXRoGAIgASgJIuIBCg1DdXJzb3JQYWNrYWdlEgwKBG5hbWUYASABKAkSEwoLZGVzY3JpcHRpb24YAiABKAkSEwoLZm9sZGVyX3BhdGgYAyABKAkSDwoHZW5hYmxlZBgEIAEoCBIYCgtwYXJzZV9lcnJvchgFIAEoCUgAiAEBEi4KB3Byb21wdHMYBiADKAsyHS5hZ2VudC52MS5DdXJzb3JQYWNrYWdlUHJvbXB0EhgKEHJlYWRtZV9maWxlX3BhdGgYByABKAkSFAoMcGFja2FnZV90eXBlGAggASgFQg4KDF9wYXJzZV9lcnJvciKrAgoWUmVwb3NpdG9yeUluZGV4aW5nSW5mbxIfChdyZWxhdGl2ZV93b3Jrc3BhY2VfcGF0aBgBIAEoCRITCgtyZW1vdGVfdXJscxgCIAMoCRIUCgxyZW1vdGVfbmFtZXMYAyADKAkSEQoJcmVwb19uYW1lGAQgASgJEhIKCnJlcG9fb3duZXIYBSABKAkSEgoKaXNfdHJhY2tlZBgGIAEoCBIQCghpc19sb2NhbBgHIAEoCBImChlvcnRob2dvbmFsX3RyYW5zZm9ybV9zZWVkGAggASgBSACIAQESFQoNd29ya3NwYWNlX3VyaRgJIAEoCRIbChNwYXRoX2VuY3J5cHRpb25fa2V5GAogASgJQhwKGl9vcnRob2dvbmFsX3RyYW5zZm9ybV9zZWVkInQKElJlcXVlc3RDb250ZXh0QXJncxIdChBub3Rlc19zZXNzaW9uX2lkGAIgASgJSACIAQESGQoMd29ya3NwYWNlX2lkGAMgASgJSAGIAQFCEwoRX25vdGVzX3Nlc3Npb25faWRCDwoNX3dvcmtzcGFjZV9pZCK6AQoUUmVxdWVzdENvbnRleHRSZXN1bHQSMgoHc3VjY2VzcxgBIAEoCzIfLmFnZW50LnYxLlJlcXVlc3RDb250ZXh0U3VjY2Vzc0gAEi4KBWVycm9yGAIgASgLMh0uYWdlbnQudjEuUmVxdWVzdENvbnRleHRFcnJvckgAEjQKCHJlamVjdGVkGAMgASgLMiAuYWdlbnQudjEuUmVxdWVzdENvbnRleHRSZWplY3RlZEgAQggKBnJlc3VsdCJKChVSZXF1ZXN0Q29udGV4dFN1Y2Nlc3MSMQoPcmVxdWVzdF9jb250ZXh0GAEgASgLMhguYWdlbnQudjEuUmVxdWVzdENvbnRleHQiJAoTUmVxdWVzdENvbnRleHRFcnJvchINCgVlcnJvchgBIAEoCSIoChZSZXF1ZXN0Q29udGV4dFJlamVjdGVkEg4KBnJlYXNvbhgBIAEoCSLCAQoKSW1hZ2VQcm90bxIMCgRkYXRhGAEgASgMEgwKBHV1aWQYAiABKAkSDAoEcGF0aBgDIAEoCRIxCglkaW1lbnNpb24YBCABKAsyHi5hZ2VudC52MS5JbWFnZVByb3RvX0RpbWVuc2lvbhImChl0YXNrX3NwZWNpZmljX2Rlc2NyaXB0aW9uGAYgASgJSACIAQESEQoJbWltZV90eXBlGAcgASgJQhwKGl90YXNrX3NwZWNpZmljX2Rlc2NyaXB0aW9uIjUKFEltYWdlUHJvdG9fRGltZW5zaW9uEg0KBXdpZHRoGAEgASgFEg4KBmhlaWdodBgCIAEoBSJoCgtHaXRSZXBvSW5mbxIMCgRwYXRoGAEgASgJEg4KBnN0YXR1cxgCIAEoCRITCgticmFuY2hfbmFtZRgDIAEoCRIXCgpyZW1vdGVfdXJsGAQgASgJSACIAQFCDQoLX3JlbW90ZV91cmwimwIKEVJlcXVlc3RDb250ZXh0RW52EhIKCm9zX3ZlcnNpb24YASABKAkSFwoPd29ya3NwYWNlX3BhdGhzGAIgAygJEg0KBXNoZWxsGAMgASgJEhcKD3NhbmRib3hfZW5hYmxlZBgFIAEoCBIYChB0ZXJtaW5hbHNfZm9sZGVyGAcgASgJEiEKGWFnZW50X3NoYXJlZF9ub3Rlc19mb2xkZXIYCCABKAkSJwofYWdlbnRfY29udmVyc2F0aW9uX25vdGVzX2ZvbGRlchgJIAEoCRIRCgl0aW1lX3pvbmUYCiABKAkSFgoOcHJvamVjdF9mb2xkZXIYCyABKAkSIAoYYWdlbnRfdHJhbnNjcmlwdHNfZm9sZGVyGAwgASgJIjwKD0RlYnVnTW9kZUNvbmZpZxIQCghsb2dfcGF0aBgBIAEoCRIXCg9zZXJ2ZXJfZW5kcG9pbnQYAiABKAkitAEKD1NraWxsRGVzY3JpcHRvchIMCgRuYW1lGAEgASgJEhMKC2Rlc2NyaXB0aW9uGAIgASgJEhMKC2ZvbGRlcl9wYXRoGAMgASgJEg8KB2VuYWJsZWQYBCABKAgSGAoLcGFyc2VfZXJyb3IYBSABKAlIAIgBARIYChByZWFkbWVfZmlsZV9wYXRoGAYgASgJEhQKDHBhY2thZ2VfdHlwZRgHIAEoBUIOCgxfcGFyc2VfZXJyb3IiRAoMU2tpbGxPcHRpb25zEjQKEXNraWxsX2Rlc2NyaXB0b3JzGAEgAygLMhkuYWdlbnQudjEuU2tpbGxEZXNjcmlwdG9yIvYICg5SZXF1ZXN0Q29udGV4dBIjCgVydWxlcxgCIAMoCzIULmFnZW50LnYxLkN1cnNvclJ1bGUSKAoDZW52GAQgASgLMhsuYWdlbnQudjEuUmVxdWVzdENvbnRleHRFbnYSOQoPcmVwb3NpdG9yeV9pbmZvGAYgAygLMiAuYWdlbnQudjEuUmVwb3NpdG9yeUluZGV4aW5nSW5mbxIqCgV0b29scxgHIAMoCzIbLmFnZW50LnYxLk1jcFRvb2xEZWZpbml0aW9uEicKGmNvbnZlcnNhdGlvbl9ub3Rlc19saXN0aW5nGAggASgJSACIAQESIQoUc2hhcmVkX25vdGVzX2xpc3RpbmcYCSABKAlIAYgBARIoCglnaXRfcmVwb3MYCyADKAsyFS5hZ2VudC52MS5HaXRSZXBvSW5mbxI2Cg9wcm9qZWN0X2xheW91dHMYDSADKAsyHS5hZ2VudC52MS5Mc0RpcmVjdG9yeVRyZWVOb2RlEjMKEG1jcF9pbnN0cnVjdGlvbnMYDiADKAsyGS5hZ2VudC52MS5NY3BJbnN0cnVjdGlvbnMSOQoRZGVidWdfbW9kZV9jb25maWcYDyABKAsyGS5hZ2VudC52MS5EZWJ1Z01vZGVDb25maWdIAogBARIXCgpjbG91ZF9ydWxlGBAgASgJSAOIAQESHwoSd2ViX3NlYXJjaF9lbmFibGVkGBEgASgISASIAQESMgoNc2tpbGxfb3B0aW9ucxgSIAEoCzIWLmFnZW50LnYxLlNraWxsT3B0aW9uc0gFiAEBEi4KIXJlcG9zaXRvcnlfaW5mb19zaG91bGRfcXVlcnlfcHJvZBgTIAEoCEgGiAEBEkEKDWZpbGVfY29udGVudHMYFCADKAsyKi5hZ2VudC52MS5SZXF1ZXN0Q29udGV4dC5GaWxlQ29udGVudHNFbnRyeRIgChN1c2VyX2ludGVudF9zdW1tYXJ5GBUgASgJSAeIAQESMgoQY3VzdG9tX3N1YmFnZW50cxgWIAMoCzIYLmFnZW50LnYxLkN1c3RvbVN1YmFnZW50EkQKF21jcF9maWxlX3N5c3RlbV9vcHRpb25zGBcgASgLMh4uYWdlbnQudjEuTWNwRmlsZVN5c3RlbU9wdGlvbnNICIgBARozChFGaWxlQ29udGVudHNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBQh0KG19jb252ZXJzYXRpb25fbm90ZXNfbGlzdGluZ0IXChVfc2hhcmVkX25vdGVzX2xpc3RpbmdCFAoSX2RlYnVnX21vZGVfY29uZmlnQg0KC19jbG91ZF9ydWxlQhUKE193ZWJfc2VhcmNoX2VuYWJsZWRCEAoOX3NraWxsX29wdGlvbnNCJAoiX3JlcG9zaXRvcnlfaW5mb19zaG91bGRfcXVlcnlfcHJvZEIWChRfdXNlcl9pbnRlbnRfc3VtbWFyeUIaChhfbWNwX2ZpbGVfc3lzdGVtX29wdGlvbnMisgIKDVNhbmRib3hQb2xpY3kSDAoEdHlwZRgBIAEoBRIbCg5uZXR3b3JrX2FjY2VzcxgCIAEoCEgAiAEBEiIKGmFkZGl0aW9uYWxfcmVhZHdyaXRlX3BhdGhzGAMgAygJEiEKGWFkZGl0aW9uYWxfcmVhZG9ubHlfcGF0aHMYBCADKAkSHQoQZGVidWdfb3V0cHV0X2RpchgFIAEoCUgBiAEBEh0KEGJsb2NrX2dpdF93cml0ZXMYBiABKAhIAogBARIeChFkaXNhYmxlX3RtcF93cml0ZRgHIAEoCEgDiAEBQhEKD19uZXR3b3JrX2FjY2Vzc0ITChFfZGVidWdfb3V0cHV0X2RpckITChFfYmxvY2tfZ2l0X3dyaXRlc0IUChJfZGlzYWJsZV90bXBfd3JpdGUi7wEKDVNlbGVjdGVkSW1hZ2USDAoEdXVpZBgCIAEoCRIMCgRwYXRoGAMgASgJEjQKCWRpbWVuc2lvbhgEIAEoCzIhLmFnZW50LnYxLlNlbGVjdGVkSW1hZ2VfRGltZW5zaW9uEhEKCW1pbWVfdHlwZRgHIAEoCRIRCgdibG9iX2lkGAEgASgMSAASDgoEZGF0YRgIIAEoDEgAEkMKEWJsb2JfaWRfd2l0aF9kYXRhGAkgASgLMiYuYWdlbnQudjEuU2VsZWN0ZWRJbWFnZV9CbG9iSWRXaXRoRGF0YUgAQhEKD2RhdGFfb3JfYmxvYl9pZCI9ChxTZWxlY3RlZEltYWdlX0Jsb2JJZFdpdGhEYXRhEg8KB2Jsb2JfaWQYASABKAwSDAoEZGF0YRgCIAEoDCI4ChdTZWxlY3RlZEltYWdlX0RpbWVuc2lvbhINCgV3aWR0aBgBIAEoBRIOCgZoZWlnaHQYAiABKAUiSQoRRXh0cmFDb250ZXh0RW50cnkSDgoEZGF0YRgBIAEoCUgAEhEKB2Jsb2JfaWQYAiABKAxIAEIRCg9kYXRhX29yX2Jsb2JfaWQiWwoMU2VsZWN0ZWRGaWxlEg8KB2NvbnRlbnQYASABKAkSDAoEcGF0aBgCIAEoCRIaCg1yZWxhdGl2ZV9wYXRoGAMgASgJSACIAQFCEAoOX3JlbGF0aXZlX3BhdGgihAEKFVNlbGVjdGVkQ29kZVNlbGVjdGlvbhIPCgdjb250ZW50GAEgASgJEgwKBHBhdGgYAiABKAkSGgoNcmVsYXRpdmVfcGF0aBgDIAEoCUgAiAEBEh4KBXJhbmdlGAQgASgLMg8uYWdlbnQudjEuUmFuZ2VCEAoOX3JlbGF0aXZlX3BhdGgiXQoQU2VsZWN0ZWRUZXJtaW5hbBIPCgdjb250ZW50GAEgASgJEhIKBXRpdGxlGAIgASgJSACIAQESEQoEcGF0aBgDIAEoCUgBiAEBQggKBl90aXRsZUIHCgVfcGF0aCKGAQoZU2VsZWN0ZWRUZXJtaW5hbFNlbGVjdGlvbhIPCgdjb250ZW50GAEgASgJEhIKBXRpdGxlGAIgASgJSACIAQESEQoEcGF0aBgDIAEoCUgBiAEBEh4KBXJhbmdlGAQgASgLMg8uYWdlbnQudjEuUmFuZ2VCCAoGX3RpdGxlQgcKBV9wYXRoIoMBCg5TZWxlY3RlZEZvbGRlchIMCgRwYXRoGAEgASgJEhoKDXJlbGF0aXZlX3BhdGgYAiABKAlIAIgBARI1Cg5kaXJlY3RvcnlfdHJlZRgDIAEoCzIdLmFnZW50LnYxLkxzRGlyZWN0b3J5VHJlZU5vZGVCEAoOX3JlbGF0aXZlX3BhdGginwEKFFNlbGVjdGVkRXh0ZXJuYWxMaW5rEgsKA3VybBgBIAEoCRIMCgR1dWlkGAIgASgJEhgKC3BkZl9jb250ZW50GAMgASgJSACIAQESEwoGaXNfcGRmGAQgASgISAGIAQESFQoIZmlsZW5hbWUYBSABKAlIAogBAUIOCgxfcGRmX2NvbnRlbnRCCQoHX2lzX3BkZkILCglfZmlsZW5hbWUiOAoSU2VsZWN0ZWRDdXJzb3JSdWxlEiIKBHJ1bGUYASABKAsyFC5hZ2VudC52MS5DdXJzb3JSdWxlIiIKD1NlbGVjdGVkR2l0RGlmZhIPCgdjb250ZW50GAEgASgJIjIKH1NlbGVjdGVkR2l0RGlmZkZyb21CcmFuY2hUb01haW4SDwoHY29udGVudBgBIAEoCSJpChFTZWxlY3RlZEdpdENvbW1pdBILCgNzaGEYASABKAkSDwoHbWVzc2FnZRgCIAEoCRIYCgtkZXNjcmlwdGlvbhgDIAEoCUgAiAEBEgwKBGRpZmYYBCABKAlCDgoMX2Rlc2NyaXB0aW9uIt0BChNTZWxlY3RlZFB1bGxSZXF1ZXN0Eg4KBm51bWJlchgBIAEoBRILCgN1cmwYAiABKAkSEgoFdGl0bGUYAyABKAlIAIgBARITCgtmb2xkZXJfcGF0aBgEIAEoCRIZCgxzdW1tYXJ5X2pzb24YBSABKAlIAYgBARIYCgtkZXNjcmlwdGlvbhgGIAEoCUgCiAEBEhQKB2Jsb2JfaWQYByABKAxIA4gBAUIICgZfdGl0bGVCDwoNX3N1bW1hcnlfanNvbkIOCgxfZGVzY3JpcHRpb25CCgoIX2Jsb2JfaWQiswEKGlNlbGVjdGVkR2l0UFJEaWZmU2VsZWN0aW9uEg4KBnByX3VybBgBIAEoCRIRCglmaWxlX3BhdGgYAiABKAkSEgoKc3RhcnRfbGluZRgDIAEoBRIQCghlbmRfbGluZRgEIAEoBRIZCgxkaWZmX2NvbnRlbnQYBSABKAlIAIgBARIUCgdibG9iX2lkGAYgASgMSAGIAQFCDwoNX2RpZmZfY29udGVudEIKCghfYmxvYl9pZCI2ChVTZWxlY3RlZEN1cnNvckNvbW1hbmQSDAoEbmFtZRgBIAEoCRIPCgdjb250ZW50GAIgASgJIjUKFVNlbGVjdGVkRG9jdW1lbnRhdGlvbhIOCgZkb2NfaWQYASABKAkSDAoEbmFtZRgCIAEoCSIyChBTZWxlY3RlZFBhc3RDaGF0EhAKCGFnZW50X2lkGAEgASgJEgwKBG5hbWUYAiABKAkiqwEKCUNhbGxGcmFtZRIaCg1mdW5jdGlvbl9uYW1lGAEgASgJSACIAQESEAoDdXJsGAIgASgJSAGIAQESGAoLbGluZV9udW1iZXIYAyABKAVIAogBARIaCg1jb2x1bW5fbnVtYmVyGAQgASgFSAOIAQFCEAoOX2Z1bmN0aW9uX25hbWVCBgoEX3VybEIOCgxfbGluZV9udW1iZXJCEAoOX2NvbHVtbl9udW1iZXIiaAoKU3RhY2tUcmFjZRIoCgtjYWxsX2ZyYW1lcxgBIAMoCzITLmFnZW50LnYxLkNhbGxGcmFtZRIcCg9yYXdfc3RhY2tfdHJhY2UYAiABKAlIAIgBAUISChBfcmF3X3N0YWNrX3RyYWNlIuQBChJTZWxlY3RlZENvbnNvbGVMb2cSDwoHbWVzc2FnZRgBIAEoCRIRCgl0aW1lc3RhbXAYAiABKAESDQoFbGV2ZWwYAyABKAkSEwoLY2xpZW50X25hbWUYBCABKAkSEgoKc2Vzc2lvbl9pZBgFIAEoCRIuCgtzdGFja190cmFjZRgGIAEoCzIULmFnZW50LnYxLlN0YWNrVHJhY2VIAIgBARIdChBvYmplY3RfZGF0YV9qc29uGAcgASgJSAGIAQFCDgoMX3N0YWNrX3RyYWNlQhMKEV9vYmplY3RfZGF0YV9qc29uIroBChFTZWxlY3RlZFVJRWxlbWVudBIPCgdlbGVtZW50GAEgASgJEg0KBXhwYXRoGAIgASgJEhQKDHRleHRfY29udGVudBgDIAEoCRINCgVleHRyYRgEIAEoCRIWCgljb21wb25lbnQYBSABKAlIAIgBARIhChRjb21wb25lbnRfcHJvcHNfanNvbhgGIAEoCUgBiAEBQgwKCl9jb21wb25lbnRCFwoVX2NvbXBvbmVudF9wcm9wc19qc29uIiAKEFNlbGVjdGVkU3ViYWdlbnQSDAoEbmFtZRgBIAEoCSKCCgoPU2VsZWN0ZWRDb250ZXh0EjAKD3NlbGVjdGVkX2ltYWdlcxgBIAMoCzIXLmFnZW50LnYxLlNlbGVjdGVkSW1hZ2USPAoSaW52b2NhdGlvbl9jb250ZXh0GAIgASgLMhsuYWdlbnQudjEuSW52b2NhdGlvbkNvbnRleHRIAIgBARIVCg1leHRyYV9jb250ZXh0GAMgAygJEjoKFWV4dHJhX2NvbnRleHRfZW50cmllcxgQIAMoCzIbLmFnZW50LnYxLkV4dHJhQ29udGV4dEVudHJ5EiUKBWZpbGVzGAQgAygLMhYuYWdlbnQudjEuU2VsZWN0ZWRGaWxlEjgKD2NvZGVfc2VsZWN0aW9ucxgFIAMoCzIfLmFnZW50LnYxLlNlbGVjdGVkQ29kZVNlbGVjdGlvbhItCgl0ZXJtaW5hbHMYBiADKAsyGi5hZ2VudC52MS5TZWxlY3RlZFRlcm1pbmFsEkAKE3Rlcm1pbmFsX3NlbGVjdGlvbnMYByADKAsyIy5hZ2VudC52MS5TZWxlY3RlZFRlcm1pbmFsU2VsZWN0aW9uEikKB2ZvbGRlcnMYCCADKAsyGC5hZ2VudC52MS5TZWxlY3RlZEZvbGRlchI2Cg5leHRlcm5hbF9saW5rcxgJIAMoCzIeLmFnZW50LnYxLlNlbGVjdGVkRXh0ZXJuYWxMaW5rEjIKDGN1cnNvcl9ydWxlcxgKIAMoCzIcLmFnZW50LnYxLlNlbGVjdGVkQ3Vyc29yUnVsZRIwCghnaXRfZGlmZhgSIAEoCzIZLmFnZW50LnYxLlNlbGVjdGVkR2l0RGlmZkgBiAEBElQKHGdpdF9kaWZmX2Zyb21fYnJhbmNoX3RvX21haW4YCyABKAsyKS5hZ2VudC52MS5TZWxlY3RlZEdpdERpZmZGcm9tQnJhbmNoVG9NYWluSAKIAQESOAoPY3Vyc29yX2NvbW1hbmRzGAwgAygLMh8uYWdlbnQudjEuU2VsZWN0ZWRDdXJzb3JDb21tYW5kEjcKDmRvY3VtZW50YXRpb25zGA0gAygLMh8uYWdlbnQudjEuU2VsZWN0ZWREb2N1bWVudGF0aW9uEjAKC3VpX2VsZW1lbnRzGA4gAygLMhsuYWdlbnQudjEuU2VsZWN0ZWRVSUVsZW1lbnQSMgoMY29uc29sZV9sb2dzGA8gAygLMhwuYWdlbnQudjEuU2VsZWN0ZWRDb25zb2xlTG9nEjAKC2dpdF9jb21taXRzGBEgAygLMhsuYWdlbnQudjEuU2VsZWN0ZWRHaXRDb21taXQSLgoKcGFzdF9jaGF0cxgTIAMoCzIaLmFnZW50LnYxLlNlbGVjdGVkUGFzdENoYXQSRAoWZ2l0X3ByX2RpZmZfc2VsZWN0aW9ucxgUIAMoCzIkLmFnZW50LnYxLlNlbGVjdGVkR2l0UFJEaWZmU2VsZWN0aW9uEj0KFnNlbGVjdGVkX3B1bGxfcmVxdWVzdHMYFSADKAsyHS5hZ2VudC52MS5TZWxlY3RlZFB1bGxSZXF1ZXN0EjYKEnNlbGVjdGVkX3N1YmFnZW50cxgWIAMoCzIaLmFnZW50LnYxLlNlbGVjdGVkU3ViYWdlbnRCFQoTX2ludm9jYXRpb25fY29udGV4dEILCglfZ2l0X2RpZmZCHwodX2dpdF9kaWZmX2Zyb21fYnJhbmNoX3RvX21haW4i5QEKEUludm9jYXRpb25Db250ZXh0Ej8KDHNsYWNrX3RocmVhZBgBIAEoCzInLmFnZW50LnYxLkludm9jYXRpb25Db250ZXh0X1NsYWNrVGhyZWFkSAASOQoJZ2l0aHViX3ByGAIgASgLMiQuYWdlbnQudjEuSW52b2NhdGlvbkNvbnRleHRfR2l0aHViUFJIABI5CglpZGVfc3RhdGUYAyABKAsyJC5hZ2VudC52MS5JbnZvY2F0aW9uQ29udGV4dF9JZGVTdGF0ZUgAEhEKB2Jsb2JfaWQYCiABKAxIAEIGCgRkYXRhIrsBCh1JbnZvY2F0aW9uQ29udGV4dF9TbGFja1RocmVhZBIOCgZ0aHJlYWQYASABKAkSGQoMY2hhbm5lbF9uYW1lGAIgASgJSACIAQESHAoPY2hhbm5lbF9wdXJwb3NlGAMgASgJSAGIAQESGgoNY2hhbm5lbF90b3BpYxgEIAEoCUgCiAEBQg8KDV9jaGFubmVsX25hbWVCEgoQX2NoYW5uZWxfcHVycG9zZUIQCg5fY2hhbm5lbF90b3BpYyJ8ChpJbnZvY2F0aW9uQ29udGV4dF9HaXRodWJQUhINCgV0aXRsZRgBIAEoCRITCgtkZXNjcmlwdGlvbhgCIAEoCRIQCghjb21tZW50cxgDIAEoCRIYCgtjaV9mYWlsdXJlcxgEIAEoCUgAiAEBQg4KDF9jaV9mYWlsdXJlcyL+AQoaSW52b2NhdGlvbkNvbnRleHRfSWRlU3RhdGUSQAoNdmlzaWJsZV9maWxlcxgBIAMoCzIpLmFnZW50LnYxLkludm9jYXRpb25Db250ZXh0X0lkZVN0YXRlX0ZpbGUSSAoVcmVjZW50bHlfdmlld2VkX2ZpbGVzGAIgAygLMikuYWdlbnQudjEuSW52b2NhdGlvbkNvbnRleHRfSWRlU3RhdGVfRmlsZRJUChRjdXJyZW50bHlfdmlld2VkX3BycxgDIAMoCzI2LmFnZW50LnYxLkludm9jYXRpb25Db250ZXh0X0lkZVN0YXRlX1ZpZXdlZFB1bGxSZXF1ZXN0Io4CCh9JbnZvY2F0aW9uQ29udGV4dF9JZGVTdGF0ZV9GaWxlEgwKBHBhdGgYASABKAkSGgoNcmVsYXRpdmVfcGF0aBgCIAEoCUgAiAEBElYKD2N1cnNvcl9wb3NpdGlvbhgDIAEoCzI4LmFnZW50LnYxLkludm9jYXRpb25Db250ZXh0X0lkZVN0YXRlX0ZpbGVfQ3Vyc29yUG9zaXRpb25IAYgBARITCgt0b3RhbF9saW5lcxgEIAEoBRIbCg5hY3RpdmVfY29tbWFuZBgFIAEoCUgCiAEBQhAKDl9yZWxhdGl2ZV9wYXRoQhIKEF9jdXJzb3JfcG9zaXRpb25CEQoPX2FjdGl2ZV9jb21tYW5kIkwKLkludm9jYXRpb25Db250ZXh0X0lkZVN0YXRlX0ZpbGVfQ3Vyc29yUG9zaXRpb24SDAoEbGluZRgBIAEoBRIMCgR0ZXh0GAIgASgJIukBCixJbnZvY2F0aW9uQ29udGV4dF9JZGVTdGF0ZV9WaWV3ZWRQdWxsUmVxdWVzdBIOCgZudW1iZXIYASABKAUSCwoDdXJsGAIgASgJEhIKBXRpdGxlGAMgASgJSACIAQESGAoLZm9sZGVyX3BhdGgYBCABKAlIAYgBARIZCgxzdW1tYXJ5X2pzb24YBSABKAlIAogBARIYCgtkZXNjcmlwdGlvbhgGIAEoCUgDiAEBQggKBl90aXRsZUIOCgxfZm9sZGVyX3BhdGhCDwoNX3N1bW1hcnlfanNvbkIOCgxfZGVzY3JpcHRpb24iSAoWU2V0dXBWbUVudmlyb25tZW50QXJncxIXCg9pbnN0YWxsX2NvbW1hbmQYAiABKAkSFQoNc3RhcnRfY29tbWFuZBgDIAEoCSJcChhTZXR1cFZtRW52aXJvbm1lbnRSZXN1bHQSNgoHc3VjY2VzcxgBIAEoCzIjLmFnZW50LnYxLlNldHVwVm1FbnZpcm9ubWVudFN1Y2Nlc3NIAEIICgZyZXN1bHQiGwoZU2V0dXBWbUVudmlyb25tZW50U3VjY2VzcyKAAQoaU2V0dXBWbUVudmlyb25tZW50VG9vbENhbGwSLgoEYXJncxgBIAEoCzIgLmFnZW50LnYxLlNldHVwVm1FbnZpcm9ubWVudEFyZ3MSMgoGcmVzdWx0GAIgASgLMiIuYWdlbnQudjEuU2V0dXBWbUVudmlyb25tZW50UmVzdWx0IsABChlTaGVsbENvbW1hbmRQYXJzaW5nUmVzdWx0EhYKDnBhcnNpbmdfZmFpbGVkGAEgASgIElIKE2V4ZWN1dGFibGVfY29tbWFuZHMYAiADKAsyNS5hZ2VudC52MS5TaGVsbENvbW1hbmRQYXJzaW5nUmVzdWx0X0V4ZWN1dGFibGVDb21tYW5kEhUKDWhhc19yZWRpcmVjdHMYAyABKAgSIAoYaGFzX2NvbW1hbmRfc3Vic3RpdHV0aW9uGAQgASgIIk0KLlNoZWxsQ29tbWFuZFBhcnNpbmdSZXN1bHRfRXhlY3V0YWJsZUNvbW1hbmRBcmcSDAoEdHlwZRgBIAEoCRINCgV2YWx1ZRgCIAEoCSKWAQorU2hlbGxDb21tYW5kUGFyc2luZ1Jlc3VsdF9FeGVjdXRhYmxlQ29tbWFuZBIMCgRuYW1lGAEgASgJEkYKBGFyZ3MYAiADKAsyOC5hZ2VudC52MS5TaGVsbENvbW1hbmRQYXJzaW5nUmVzdWx0X0V4ZWN1dGFibGVDb21tYW5kQXJnEhEKCWZ1bGxfdGV4dBgDIAEoCSKIBAoJU2hlbGxBcmdzEg8KB2NvbW1hbmQYASABKAkSGQoRd29ya2luZ19kaXJlY3RvcnkYAiABKAkSDwoHdGltZW91dBgDIAEoBRIUCgx0b29sX2NhbGxfaWQYBCABKAkSFwoPc2ltcGxlX2NvbW1hbmRzGAUgAygJEhoKEmhhc19pbnB1dF9yZWRpcmVjdBgGIAEoCBIbChNoYXNfb3V0cHV0X3JlZGlyZWN0GAcgASgIEjsKDnBhcnNpbmdfcmVzdWx0GAggASgLMiMuYWdlbnQudjEuU2hlbGxDb21tYW5kUGFyc2luZ1Jlc3VsdBI+ChhyZXF1ZXN0ZWRfc2FuZGJveF9wb2xpY3kYCSABKAsyFy5hZ2VudC52MS5TYW5kYm94UG9saWN5SACIAQESKAobZmlsZV9vdXRwdXRfdGhyZXNob2xkX2J5dGVzGAogASgESAGIAQESFQoNaXNfYmFja2dyb3VuZBgLIAEoCBIVCg1za2lwX2FwcHJvdmFsGAwgASgIEhgKEHRpbWVvdXRfYmVoYXZpb3IYDSABKAUSGQoMaGFyZF90aW1lb3V0GA4gASgFSAKIAQFCGwoZX3JlcXVlc3RlZF9zYW5kYm94X3BvbGljeUIeChxfZmlsZV9vdXRwdXRfdGhyZXNob2xkX2J5dGVzQg8KDV9oYXJkX3RpbWVvdXQi+gMKC1NoZWxsUmVzdWx0EjQKDnNhbmRib3hfcG9saWN5GGUgASgLMhcuYWdlbnQudjEuU2FuZGJveFBvbGljeUgBiAEBEhoKDWlzX2JhY2tncm91bmQYZiABKAhIAogBARIdChB0ZXJtaW5hbHNfZm9sZGVyGGcgASgJSAOIAQESEAoDcGlkGGggASgNSASIAQESKQoHc3VjY2VzcxgBIAEoCzIWLmFnZW50LnYxLlNoZWxsU3VjY2Vzc0gAEikKB2ZhaWx1cmUYAiABKAsyFi5hZ2VudC52MS5TaGVsbEZhaWx1cmVIABIpCgd0aW1lb3V0GAMgASgLMhYuYWdlbnQudjEuU2hlbGxUaW1lb3V0SAASKwoIcmVqZWN0ZWQYBCABKAsyFy5hZ2VudC52MS5TaGVsbFJlamVjdGVkSAASMAoLc3Bhd25fZXJyb3IYBSABKAsyGS5hZ2VudC52MS5TaGVsbFNwYXduRXJyb3JIABI8ChFwZXJtaXNzaW9uX2RlbmllZBgHIAEoCzIfLmFnZW50LnYxLlNoZWxsUGVybWlzc2lvbkRlbmllZEgAQggKBnJlc3VsdEIRCg9fc2FuZGJveF9wb2xpY3lCEAoOX2lzX2JhY2tncm91bmRCEwoRX3Rlcm1pbmFsc19mb2xkZXJCBgoEX3BpZCIhChFTaGVsbFN0cmVhbVN0ZG91dBIMCgRkYXRhGAEgASgJIiEKEVNoZWxsU3RyZWFtU3RkZXJyEgwKBGRhdGEYASABKAkitQEKD1NoZWxsU3RyZWFtRXhpdBIMCgRjb2RlGAEgASgNEgsKA2N3ZBgCIAEoCRI2Cg9vdXRwdXRfbG9jYXRpb24YAyABKAsyGC5hZ2VudC52MS5PdXRwdXRMb2NhdGlvbkgAiAEBEg8KB2Fib3J0ZWQYBCABKAgSGQoMYWJvcnRfcmVhc29uGAUgASgFSAGIAQFCEgoQX291dHB1dF9sb2NhdGlvbkIPCg1fYWJvcnRfcmVhc29uIlsKEFNoZWxsU3RyZWFtU3RhcnQSNAoOc2FuZGJveF9wb2xpY3kYASABKAsyFy5hZ2VudC52MS5TYW5kYm94UG9saWN5SACIAQFCEQoPX3NhbmRib3hfcG9saWN5IpkBChdTaGVsbFN0cmVhbUJhY2tncm91bmRlZBIQCghzaGVsbF9pZBgBIAEoDRIPCgdjb21tYW5kGAIgASgJEhkKEXdvcmtpbmdfZGlyZWN0b3J5GAMgASgJEhAKA3BpZBgEIAEoDUgAiAEBEhcKCm1zX3RvX3dhaXQYBSABKAVIAYgBAUIGCgRfcGlkQg0KC19tc190b193YWl0IvICCgtTaGVsbFN0cmVhbRItCgZzdGRvdXQYASABKAsyGy5hZ2VudC52MS5TaGVsbFN0cmVhbVN0ZG91dEgAEi0KBnN0ZGVychgCIAEoCzIbLmFnZW50LnYxLlNoZWxsU3RyZWFtU3RkZXJySAASKQoEZXhpdBgDIAEoCzIZLmFnZW50LnYxLlNoZWxsU3RyZWFtRXhpdEgAEisKBXN0YXJ0GAQgASgLMhouYWdlbnQudjEuU2hlbGxTdHJlYW1TdGFydEgAEisKCHJlamVjdGVkGAUgASgLMhcuYWdlbnQudjEuU2hlbGxSZWplY3RlZEgAEjwKEXBlcm1pc3Npb25fZGVuaWVkGAYgASgLMh8uYWdlbnQudjEuU2hlbGxQZXJtaXNzaW9uRGVuaWVkSAASOQoMYmFja2dyb3VuZGVkGAcgASgLMiEuYWdlbnQudjEuU2hlbGxTdHJlYW1CYWNrZ3JvdW5kZWRIAEIHCgVldmVudCJLCg5PdXRwdXRMb2NhdGlvbhIRCglmaWxlX3BhdGgYASABKAkSEgoKc2l6ZV9ieXRlcxgCIAEoAxISCgpsaW5lX2NvdW50GAMgASgDIv8CCgxTaGVsbFN1Y2Nlc3MSDwoHY29tbWFuZBgBIAEoCRIZChF3b3JraW5nX2RpcmVjdG9yeRgCIAEoCRIRCglleGl0X2NvZGUYAyABKAUSDgoGc2lnbmFsGAQgASgJEg4KBnN0ZG91dBgFIAEoCRIOCgZzdGRlcnIYBiABKAkSFgoOZXhlY3V0aW9uX3RpbWUYByABKAUSNgoPb3V0cHV0X2xvY2F0aW9uGAggASgLMhguYWdlbnQudjEuT3V0cHV0TG9jYXRpb25IAIgBARIVCghzaGVsbF9pZBgJIAEoDUgBiAEBEh8KEmludGVybGVhdmVkX291dHB1dBgKIAEoCUgCiAEBEhAKA3BpZBgLIAEoDUgDiAEBEhcKCm1zX3RvX3dhaXQYDCABKAVIBIgBAUISChBfb3V0cHV0X2xvY2F0aW9uQgsKCV9zaGVsbF9pZEIVChNfaW50ZXJsZWF2ZWRfb3V0cHV0QgYKBF9waWRCDQoLX21zX3RvX3dhaXQi1gIKDFNoZWxsRmFpbHVyZRIPCgdjb21tYW5kGAEgASgJEhkKEXdvcmtpbmdfZGlyZWN0b3J5GAIgASgJEhEKCWV4aXRfY29kZRgDIAEoBRIOCgZzaWduYWwYBCABKAkSDgoGc3Rkb3V0GAUgASgJEg4KBnN0ZGVychgGIAEoCRIWCg5leGVjdXRpb25fdGltZRgHIAEoBRI2Cg9vdXRwdXRfbG9jYXRpb24YCCABKAsyGC5hZ2VudC52MS5PdXRwdXRMb2NhdGlvbkgAiAEBEh8KEmludGVybGVhdmVkX291dHB1dBgJIAEoCUgBiAEBEhkKDGFib3J0X3JlYXNvbhgKIAEoBUgCiAEBEg8KB2Fib3J0ZWQYCyABKAhCEgoQX291dHB1dF9sb2NhdGlvbkIVChNfaW50ZXJsZWF2ZWRfb3V0cHV0Qg8KDV9hYm9ydF9yZWFzb24iTgoMU2hlbGxUaW1lb3V0Eg8KB2NvbW1hbmQYASABKAkSGQoRd29ya2luZ19kaXJlY3RvcnkYAiABKAkSEgoKdGltZW91dF9tcxgDIAEoBSJgCg1TaGVsbFJlamVjdGVkEg8KB2NvbW1hbmQYASABKAkSGQoRd29ya2luZ19kaXJlY3RvcnkYAiABKAkSDgoGcmVhc29uGAMgASgJEhMKC2lzX3JlYWRvbmx5GAQgASgIImcKFVNoZWxsUGVybWlzc2lvbkRlbmllZBIPCgdjb21tYW5kGAEgASgJEhkKEXdvcmtpbmdfZGlyZWN0b3J5GAIgASgJEg0KBWVycm9yGAMgASgJEhMKC2lzX3JlYWRvbmx5GAQgASgIIkwKD1NoZWxsU3Bhd25FcnJvchIPCgdjb21tYW5kGAEgASgJEhkKEXdvcmtpbmdfZGlyZWN0b3J5GAIgASgJEg0KBWVycm9yGAMgASgJIkAKElNoZWxsUGFydGlhbFJlc3VsdBIUCgxzdGRvdXRfZGVsdGEYASABKAkSFAoMc3RkZXJyX2RlbHRhGAIgASgJIlkKDVNoZWxsVG9vbENhbGwSIQoEYXJncxgBIAEoCzITLmFnZW50LnYxLlNoZWxsQXJncxIlCgZyZXN1bHQYAiABKAsyFS5hZ2VudC52MS5TaGVsbFJlc3VsdCIrChhTaGVsbFRvb2xDYWxsU3Rkb3V0RGVsdGESDwoHY29udGVudBgBIAEoCSIrChhTaGVsbFRvb2xDYWxsU3RkZXJyRGVsdGESDwoHY29udGVudBgBIAEoCSKJAQoSU2hlbGxUb29sQ2FsbERlbHRhEjQKBnN0ZG91dBgBIAEoCzIiLmFnZW50LnYxLlNoZWxsVG9vbENhbGxTdGRvdXREZWx0YUgAEjQKBnN0ZGVychgCIAEoCzIiLmFnZW50LnYxLlNoZWxsVG9vbENhbGxTdGRlcnJEZWx0YUgAQgcKBWRlbHRhIu0BCgxTdWJhZ2VudFR5cGUSOAoLdW5zcGVjaWZpZWQYASABKAsyIS5hZ2VudC52MS5TdWJhZ2VudFR5cGVVbnNwZWNpZmllZEgAEjkKDGNvbXB1dGVyX3VzZRgCIAEoCzIhLmFnZW50LnYxLlN1YmFnZW50VHlwZUNvbXB1dGVyVXNlSAASLgoGY3VzdG9tGAMgASgLMhwuYWdlbnQudjEuU3ViYWdlbnRUeXBlQ3VzdG9tSAASMAoHZXhwbG9yZRgEIAEoCzIdLmFnZW50LnYxLlN1YmFnZW50VHlwZUV4cGxvcmVIAEIGCgR0eXBlIhkKF1N1YmFnZW50VHlwZVVuc3BlY2lmaWVkIhkKF1N1YmFnZW50VHlwZUNvbXB1dGVyVXNlIhUKE1N1YmFnZW50VHlwZUV4cGxvcmUiIgoSU3ViYWdlbnRUeXBlQ3VzdG9tEgwKBG5hbWUYASABKAkijQEKDkN1c3RvbVN1YmFnZW50EhEKCWZ1bGxfcGF0aBgBIAEoCRIMCgRuYW1lGAIgASgJEhMKC2Rlc2NyaXB0aW9uGAMgASgJEg0KBXRvb2xzGAQgAygJEg0KBW1vZGVsGAUgASgJEg4KBnByb21wdBgGIAEoCRIXCg9wZXJtaXNzaW9uX21vZGUYByABKAUiaAoOU3dpdGNoTW9kZUFyZ3MSFgoOdGFyZ2V0X21vZGVfaWQYASABKAkSGAoLZXhwbGFuYXRpb24YAiABKAlIAIgBARIUCgx0b29sX2NhbGxfaWQYAyABKAlCDgoMX2V4cGxhbmF0aW9uIqoBChBTd2l0Y2hNb2RlUmVzdWx0Ei4KB3N1Y2Nlc3MYASABKAsyGy5hZ2VudC52MS5Td2l0Y2hNb2RlU3VjY2Vzc0gAEioKBWVycm9yGAIgASgLMhkuYWdlbnQudjEuU3dpdGNoTW9kZUVycm9ySAASMAoIcmVqZWN0ZWQYAyABKAsyHC5hZ2VudC52MS5Td2l0Y2hNb2RlUmVqZWN0ZWRIAEIICgZyZXN1bHQiPQoRU3dpdGNoTW9kZVN1Y2Nlc3MSFAoMZnJvbV9tb2RlX2lkGAEgASgJEhIKCnRvX21vZGVfaWQYAiABKAkiIAoPU3dpdGNoTW9kZUVycm9yEg0KBWVycm9yGAEgASgJIiQKElN3aXRjaE1vZGVSZWplY3RlZBIOCgZyZWFzb24YASABKAkiaAoSU3dpdGNoTW9kZVRvb2xDYWxsEiYKBGFyZ3MYASABKAsyGC5hZ2VudC52MS5Td2l0Y2hNb2RlQXJncxIqCgZyZXN1bHQYAiABKAsyGi5hZ2VudC52MS5Td2l0Y2hNb2RlUmVzdWx0IkAKFlN3aXRjaE1vZGVSZXF1ZXN0UXVlcnkSJgoEYXJncxgBIAEoCzIYLmFnZW50LnYxLlN3aXRjaE1vZGVBcmdzIqkBChlTd2l0Y2hNb2RlUmVxdWVzdFJlc3BvbnNlEkAKCGFwcHJvdmVkGAEgASgLMiwuYWdlbnQudjEuU3dpdGNoTW9kZVJlcXVlc3RSZXNwb25zZV9BcHByb3ZlZEgAEkAKCHJlamVjdGVkGAIgASgLMiwuYWdlbnQudjEuU3dpdGNoTW9kZVJlcXVlc3RSZXNwb25zZV9SZWplY3RlZEgAQggKBnJlc3VsdCIkCiJTd2l0Y2hNb2RlUmVxdWVzdFJlc3BvbnNlX0FwcHJvdmVkIjQKIlN3aXRjaE1vZGVSZXF1ZXN0UmVzcG9uc2VfUmVqZWN0ZWQSDgoGcmVhc29uGAEgASgJInUKCFRvZG9JdGVtEgoKAmlkGAEgASgJEg8KB2NvbnRlbnQYAiABKAkSDgoGc3RhdHVzGAMgASgFEhIKCmNyZWF0ZWRfYXQYBCABKAMSEgoKdXBkYXRlZF9hdBgFIAEoAxIUCgxkZXBlbmRlbmNpZXMYBiADKAkiawoTVXBkYXRlVG9kb3NUb29sQ2FsbBInCgRhcmdzGAEgASgLMhkuYWdlbnQudjEuVXBkYXRlVG9kb3NBcmdzEisKBnJlc3VsdBgCIAEoCzIbLmFnZW50LnYxLlVwZGF0ZVRvZG9zUmVzdWx0IkMKD1VwZGF0ZVRvZG9zQXJncxIhCgV0b2RvcxgBIAMoCzISLmFnZW50LnYxLlRvZG9JdGVtEg0KBW1lcmdlGAIgASgIInsKEVVwZGF0ZVRvZG9zUmVzdWx0Ei8KB3N1Y2Nlc3MYASABKAsyHC5hZ2VudC52MS5VcGRhdGVUb2Rvc1N1Y2Nlc3NIABIrCgVlcnJvchgCIAEoCzIaLmFnZW50LnYxLlVwZGF0ZVRvZG9zRXJyb3JIAEIICgZyZXN1bHQiXwoSVXBkYXRlVG9kb3NTdWNjZXNzEiEKBXRvZG9zGAEgAygLMhIuYWdlbnQudjEuVG9kb0l0ZW0SEwoLdG90YWxfY291bnQYAiABKAUSEQoJd2FzX21lcmdlGAMgASgIIiEKEFVwZGF0ZVRvZG9zRXJyb3ISDQoFZXJyb3IYASABKAkiZQoRUmVhZFRvZG9zVG9vbENhbGwSJQoEYXJncxgBIAEoCzIXLmFnZW50LnYxLlJlYWRUb2Rvc0FyZ3MSKQoGcmVzdWx0GAIgASgLMhkuYWdlbnQudjEuUmVhZFRvZG9zUmVzdWx0IjkKDVJlYWRUb2Rvc0FyZ3MSFQoNc3RhdHVzX2ZpbHRlchgBIAMoBRIRCglpZF9maWx0ZXIYAiADKAkidQoPUmVhZFRvZG9zUmVzdWx0Ei0KB3N1Y2Nlc3MYASABKAsyGi5hZ2VudC52MS5SZWFkVG9kb3NTdWNjZXNzSAASKQoFZXJyb3IYAiABKAsyGC5hZ2VudC52MS5SZWFkVG9kb3NFcnJvckgAQggKBnJlc3VsdCJKChBSZWFkVG9kb3NTdWNjZXNzEiEKBXRvZG9zGAEgAygLMhIuYWdlbnQudjEuVG9kb0l0ZW0SEwoLdG90YWxfY291bnQYAiABKAUiHwoOUmVhZFRvZG9zRXJyb3ISDQoFZXJyb3IYASABKAkiSwoFUmFuZ2USIQoFc3RhcnQYASABKAsyEi5hZ2VudC52MS5Qb3NpdGlvbhIfCgNlbmQYAiABKAsyEi5hZ2VudC52MS5Qb3NpdGlvbiIoCghQb3NpdGlvbhIMCgRsaW5lGAEgASgNEg4KBmNvbHVtbhgCIAEoDSIYCgVFcnJvchIPCgdtZXNzYWdlGAEgASgJIjoKDVdlYlNlYXJjaEFyZ3MSEwoLc2VhcmNoX3Rlcm0YASABKAkSFAoMdG9vbF9jYWxsX2lkGAIgASgJIqYBCg9XZWJTZWFyY2hSZXN1bHQSLQoHc3VjY2VzcxgBIAEoCzIaLmFnZW50LnYxLldlYlNlYXJjaFN1Y2Nlc3NIABIpCgVlcnJvchgCIAEoCzIYLmFnZW50LnYxLldlYlNlYXJjaEVycm9ySAASLwoIcmVqZWN0ZWQYAyABKAsyGy5hZ2VudC52MS5XZWJTZWFyY2hSZWplY3RlZEgAQggKBnJlc3VsdCJEChBXZWJTZWFyY2hTdWNjZXNzEjAKCnJlZmVyZW5jZXMYASADKAsyHC5hZ2VudC52MS5XZWJTZWFyY2hSZWZlcmVuY2UiHwoOV2ViU2VhcmNoRXJyb3ISDQoFZXJyb3IYASABKAkiIwoRV2ViU2VhcmNoUmVqZWN0ZWQSDgoGcmVhc29uGAEgASgJIj8KEldlYlNlYXJjaFJlZmVyZW5jZRINCgV0aXRsZRgBIAEoCRILCgN1cmwYAiABKAkSDQoFY2h1bmsYAyABKAkiZQoRV2ViU2VhcmNoVG9vbENhbGwSJQoEYXJncxgBIAEoCzIXLmFnZW50LnYxLldlYlNlYXJjaEFyZ3MSKQoGcmVzdWx0GAIgASgLMhkuYWdlbnQudjEuV2ViU2VhcmNoUmVzdWx0Ij4KFVdlYlNlYXJjaFJlcXVlc3RRdWVyeRIlCgRhcmdzGAEgASgLMhcuYWdlbnQudjEuV2ViU2VhcmNoQXJncyKmAQoYV2ViU2VhcmNoUmVxdWVzdFJlc3BvbnNlEj8KCGFwcHJvdmVkGAEgASgLMisuYWdlbnQudjEuV2ViU2VhcmNoUmVxdWVzdFJlc3BvbnNlX0FwcHJvdmVkSAASPwoIcmVqZWN0ZWQYAiABKAsyKy5hZ2VudC52MS5XZWJTZWFyY2hSZXF1ZXN0UmVzcG9uc2VfUmVqZWN0ZWRIAEIICgZyZXN1bHQiIwohV2ViU2VhcmNoUmVxdWVzdFJlc3BvbnNlX0FwcHJvdmVkIjMKIVdlYlNlYXJjaFJlcXVlc3RSZXNwb25zZV9SZWplY3RlZBIOCgZyZWFzb24YASABKAkifwoJV3JpdGVBcmdzEgwKBHBhdGgYASABKAkSEQoJZmlsZV90ZXh0GAIgASgJEhQKDHRvb2xfY2FsbF9pZBgDIAEoCRInCh9yZXR1cm5fZmlsZV9jb250ZW50X2FmdGVyX3dyaXRlGAQgASgIEhIKCmZpbGVfYnl0ZXMYBSABKAwigAIKC1dyaXRlUmVzdWx0EikKB3N1Y2Nlc3MYASABKAsyFi5hZ2VudC52MS5Xcml0ZVN1Y2Nlc3NIABI8ChFwZXJtaXNzaW9uX2RlbmllZBgDIAEoCzIfLmFnZW50LnYxLldyaXRlUGVybWlzc2lvbkRlbmllZEgAEioKCG5vX3NwYWNlGAQgASgLMhYuYWdlbnQudjEuV3JpdGVOb1NwYWNlSAASJQoFZXJyb3IYBSABKAsyFC5hZ2VudC52MS5Xcml0ZUVycm9ySAASKwoIcmVqZWN0ZWQYBiABKAsyFy5hZ2VudC52MS5Xcml0ZVJlamVjdGVkSABCCAoGcmVzdWx0IooBCgxXcml0ZVN1Y2Nlc3MSDAoEcGF0aBgBIAEoCRIVCg1saW5lc19jcmVhdGVkGAIgASgFEhEKCWZpbGVfc2l6ZRgDIAEoBRIlChhmaWxlX2NvbnRlbnRfYWZ0ZXJfd3JpdGUYBCABKAlIAIgBAUIbChlfZmlsZV9jb250ZW50X2FmdGVyX3dyaXRlIm8KFVdyaXRlUGVybWlzc2lvbkRlbmllZBIMCgRwYXRoGAEgASgJEhEKCWRpcmVjdG9yeRgCIAEoCRIRCglvcGVyYXRpb24YAyABKAkSDQoFZXJyb3IYBCABKAkSEwoLaXNfcmVhZG9ubHkYBSABKAgiHAoMV3JpdGVOb1NwYWNlEgwKBHBhdGgYASABKAkiKQoKV3JpdGVFcnJvchIMCgRwYXRoGAEgASgJEg0KBWVycm9yGAIgASgJIi0KDVdyaXRlUmVqZWN0ZWQSDAoEcGF0aBgBIAEoCRIOCgZyZWFzb24YAiABKAkigwEKF0Jvb3RzdHJhcFN0YXRzaWdSZXF1ZXN0Eh4KEWlnbm9yZV9kZXZfc3RhdHVzGAEgASgISACIAQESHQoQb3BlcmF0aW5nX3N5c3RlbRgCIAEoBUgBiAEBQhQKEl9pZ25vcmVfZGV2X3N0YXR1c0ITChFfb3BlcmF0aW5nX3N5c3RlbSIOCgxQaW5nUmVzcG9uc2UitwEKC0V4ZWNSZXF1ZXN0Eg8KB2NvbW1hbmQYASABKAkSEAoDY3dkGAIgASgJSACIAQESDAoEYXJncxgDIAMoCRI7CgtlbnZpcm9ubWVudBgEIAMoCzImLmFnZW50LnYxLkV4ZWNSZXF1ZXN0LkVudmlyb25tZW50RW50cnkaMgoQRW52aXJvbm1lbnRFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBQgYKBF9jd2QioAEKDEV4ZWNSZXNwb25zZRItCgxzdGRvdXRfZXZlbnQYASABKAsyFS5hZ2VudC52MS5TdGRvdXRFdmVudEgAEi0KDHN0ZGVycl9ldmVudBgCIAEoCzIVLmFnZW50LnYxLlN0ZGVyckV2ZW50SAASKQoKZXhpdF9ldmVudBgDIAEoCzITLmFnZW50LnYxLkV4aXRFdmVudEgAQgcKBWV2ZW50IhsKC1N0ZG91dEV2ZW50EgwKBGRhdGEYASABKAkiGwoLU3RkZXJyRXZlbnQSDAoEZGF0YRgBIAEoCSIeCglFeGl0RXZlbnQSEQoJZXhpdF9jb2RlGAEgASgFIiMKE1JlYWRUZXh0RmlsZVJlcXVlc3QSDAoEcGF0aBgBIAEoCSInChRSZWFkVGV4dEZpbGVSZXNwb25zZRIPCgdjb250ZW50GAEgASgJIjUKFFdyaXRlVGV4dEZpbGVSZXF1ZXN0EgwKBHBhdGgYASABKAkSDwoHY29udGVudBgCIAEoCSIXChVXcml0ZVRleHRGaWxlUmVzcG9uc2UiJQoVUmVhZEJpbmFyeUZpbGVSZXF1ZXN0EgwKBHBhdGgYASABKAkiKQoWUmVhZEJpbmFyeUZpbGVSZXNwb25zZRIPCgdjb250ZW50GAEgASgMIjcKFldyaXRlQmluYXJ5RmlsZVJlcXVlc3QSDAoEcGF0aBgBIAEoCRIPCgdjb250ZW50GAIgASgMIhkKF1dyaXRlQmluYXJ5RmlsZVJlc3BvbnNlIkUKHkdldFdvcmtzcGFjZUNoYW5nZXNIYXNoUmVxdWVzdBIRCglyb290X3BhdGgYASABKAkSEAoIYmFzZV9yZWYYAiABKAkiLwofR2V0V29ya3NwYWNlQ2hhbmdlc0hhc2hSZXNwb25zZRIMCgRoYXNoGAEgASgJIlAKH1JlZnJlc2hHaXRodWJBY2Nlc3NUb2tlblJlcXVlc3QSGwoTZ2l0aHViX2FjY2Vzc190b2tlbhgBIAEoCRIQCghob3N0bmFtZRgCIAEoCSIiCiBSZWZyZXNoR2l0aHViQWNjZXNzVG9rZW5SZXNwb25zZSJXCh1XYXJtUmVtb3RlQWNjZXNzU2VydmVyUmVxdWVzdBIOCgZjb21taXQYASABKAkSDAoEcG9ydBgCIAEoBRIYChBjb25uZWN0aW9uX3Rva2VuGAMgASgJIiAKHldhcm1SZW1vdGVBY2Nlc3NTZXJ2ZXJSZXNwb25zZSIWChRMaXN0QXJ0aWZhY3RzUmVxdWVzdCKKAgoWQXJ0aWZhY3RVcGxvYWRNZXRhZGF0YRIVCg1hYnNvbHV0ZV9wYXRoGAEgASgJEhIKCnNpemVfYnl0ZXMYAiABKAQSGgoSdXBkYXRlZF9hdF91bml4X21zGAMgASgDEg4KBnN0YXR1cxgEIAEoBRIWCg5ieXRlc191cGxvYWRlZBgFIAEoBBISCgpsYXN0X2Vycm9yGAYgASgJEhcKD3VwbG9hZF9hdHRlbXB0cxgHIAEoDRIfChdsYXN0X3N0YXJ0ZWRfYXRfdW5peF9tcxgIIAEoAxIgChhsYXN0X2ZpbmlzaGVkX2F0X3VuaXhfbXMYCSABKAMSEQoJdXBsb2FkX2lkGAogASgJIkwKFUxpc3RBcnRpZmFjdHNSZXNwb25zZRIzCglhcnRpZmFjdHMYASADKAsyIC5hZ2VudC52MS5BcnRpZmFjdFVwbG9hZE1ldGFkYXRhIk4KFlVwbG9hZEFydGlmYWN0c1JlcXVlc3QSNAoHdXBsb2FkcxgBIAMoCzIjLmFnZW50LnYxLkFydGlmYWN0VXBsb2FkSW5zdHJ1Y3Rpb24i1wIKGUFydGlmYWN0VXBsb2FkSW5zdHJ1Y3Rpb24SFQoNYWJzb2x1dGVfcGF0aBgBIAEoCRISCgp1cGxvYWRfdXJsGAIgASgJEg4KBm1ldGhvZBgDIAEoCRJBCgdoZWFkZXJzGAQgAygLMjAuYWdlbnQudjEuQXJ0aWZhY3RVcGxvYWRJbnN0cnVjdGlvbi5IZWFkZXJzRW50cnkSGQoMY29udGVudF90eXBlGAUgASgJSACIAQESHQoQc2xhY2tfdXBsb2FkX3VybBgGIAEoCUgBiAEBEhoKDXNsYWNrX2ZpbGVfaWQYByABKAlIAogBARouCgxIZWFkZXJzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgJOgI4AUIPCg1fY29udGVudF90eXBlQhMKEV9zbGFja191cGxvYWRfdXJsQhAKDl9zbGFja19maWxlX2lkIoQBChxBcnRpZmFjdFVwbG9hZERpc3BhdGNoUmVzdWx0EhUKDWFic29sdXRlX3BhdGgYASABKAkSDgoGc3RhdHVzGAIgASgFEg8KB21lc3NhZ2UYAyABKAkSGgoNc2xhY2tfZmlsZV9pZBgEIAEoCUgAiAEBQhAKDl9zbGFja19maWxlX2lkIlIKF1VwbG9hZEFydGlmYWN0c1Jlc3BvbnNlEjcKB3Jlc3VsdHMYASADKAsyJi5hZ2VudC52MS5BcnRpZmFjdFVwbG9hZERpc3BhdGNoUmVzdWx0IhwKGkdldE1jcFJlZnJlc2hUb2tlbnNSZXF1ZXN0IqUBChtHZXRNY3BSZWZyZXNoVG9rZW5zUmVzcG9uc2USUAoOcmVmcmVzaF90b2tlbnMYASADKAsyOC5hZ2VudC52MS5HZXRNY3BSZWZyZXNoVG9rZW5zUmVzcG9uc2UuUmVmcmVzaFRva2Vuc0VudHJ5GjQKElJlZnJlc2hUb2tlbnNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBIqMBCiFVcGRhdGVFbnZpcm9ubWVudFZhcmlhYmxlc1JlcXVlc3QSQQoDZW52GAEgAygLMjQuYWdlbnQudjEuVXBkYXRlRW52aXJvbm1lbnRWYXJpYWJsZXNSZXF1ZXN0LkVudkVudHJ5Eg8KB3JlcGxhY2UYAiABKAgaKgoIRW52RW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgJOgI4ASJGCiJVcGRhdGVFbnZpcm9ubWVudFZhcmlhYmxlc1Jlc3BvbnNlEg8KB2FwcGxpZWQYASABKA0SDwoHcmVtb3ZlZBgCIAEoDSKDAQoSTWNwT0F1dGhTdG9yZWREYXRhEhUKDXJlZnJlc2hfdG9rZW4YASABKAkSEQoJY2xpZW50X2lkGAIgASgJEhoKDWNsaWVudF9zZWNyZXQYAyABKAlIAIgBARIVCg1yZWRpcmVjdF91cmlzGAQgAygJQhAKDl9jbGllbnRfc2VjcmV0Ik4KBUZyYW1lEgoKAmlkGAEgASgJEg4KBm1ldGhvZBgCIAEoCRIMCgRkYXRhGAMgASgMEgwKBGtpbmQYBCABKAUSDQoFZXJyb3IYBSABKAkiBwoFRW1wdHkiIwoNQmlkaVJlcXVlc3RJZBISCgpyZXF1ZXN0X2lkGAEgASgJKogBCh1BcHBsaWVkQWdlbnRDaGFuZ2VfQ2hhbmdlVHlwZRIbChdDSEFOR0VfVFlQRV9VTlNQRUNJRklFRBAAEhcKE0NIQU5HRV9UWVBFX0NSRUFURUQQARIYChRDSEFOR0VfVFlQRV9NT0RJRklFRBACEhcKE0NIQU5HRV9UWVBFX0RFTEVURUQQAyqkAQoLTW91c2VCdXR0b24SHAoYTU9VU0VfQlVUVE9OX1VOU1BFQ0lGSUVEEAASFQoRTU9VU0VfQlVUVE9OX0xFRlQQARIWChJNT1VTRV9CVVRUT05fUklHSFQQAhIXChNNT1VTRV9CVVRUT05fTUlERExFEAMSFQoRTU9VU0VfQlVUVE9OX0JBQ0sQBBIYChRNT1VTRV9CVVRUT05fRk9SV0FSRBAFKp4BCg9TY3JvbGxEaXJlY3Rpb24SIAocU0NST0xMX0RJUkVDVElPTl9VTlNQRUNJRklFRBAAEhcKE1NDUk9MTF9ESVJFQ1RJT05fVVAQARIZChVTQ1JPTExfRElSRUNUSU9OX0RPV04QAhIZChVTQ1JPTExfRElSRUNUSU9OX0xFRlQQAxIaChZTQ1JPTExfRElSRUNUSU9OX1JJR0hUEAQqcAoQQ3Vyc29yUnVsZVNvdXJjZRIiCh5DVVJTT1JfUlVMRV9TT1VSQ0VfVU5TUEVDSUZJRUQQABIbChdDVVJTT1JfUlVMRV9TT1VSQ0VfVEVBTRABEhsKF0NVUlNPUl9SVUxFX1NPVVJDRV9VU0VSEAIqvAEKEkRpYWdub3N0aWNTZXZlcml0eRIjCh9ESUFHTk9TVElDX1NFVkVSSVRZX1VOU1BFQ0lGSUVEEAASHQoZRElBR05PU1RJQ19TRVZFUklUWV9FUlJPUhABEh8KG0RJQUdOT1NUSUNfU0VWRVJJVFlfV0FSTklORxACEiMKH0RJQUdOT1NUSUNfU0VWRVJJVFlfSU5GT1JNQVRJT04QAxIcChhESUFHTk9TVElDX1NFVkVSSVRZX0hJTlQQBCqcAQoNUmVjb3JkaW5nTW9kZRIeChpSRUNPUkRJTkdfTU9ERV9VTlNQRUNJRklFRBAAEiIKHlJFQ09SRElOR19NT0RFX1NUQVJUX1JFQ09SRElORxABEiEKHVJFQ09SRElOR19NT0RFX1NBVkVfUkVDT1JESU5HEAISJAogUkVDT1JESU5HX01PREVfRElTQ0FSRF9SRUNPUkRJTkcQAyqTAQofUmVxdWVzdGVkRmlsZVBhdGhSZWplY3RlZFJlYXNvbhIzCi9SRVFVRVNURURfRklMRV9QQVRIX1JFSkVDVEVEX1JFQVNPTl9VTlNQRUNJRklFRBAAEjsKN1JFUVVFU1RFRF9GSUxFX1BBVEhfUkVKRUNURURfUkVBU09OX1NMQVNIRVNfTk9UX0FMTE9XRUQQASqtAQoLUGFja2FnZVR5cGUSHAoYUEFDS0FHRV9UWVBFX1VOU1BFQ0lGSUVEEAASHwobUEFDS0FHRV9UWVBFX0NVUlNPUl9QUk9KRUNUEAESIAocUEFDS0FHRV9UWVBFX0NVUlNPUl9QRVJTT05BTBACEh0KGVBBQ0tBR0VfVFlQRV9DTEFVREVfU0tJTEwQAxIeChpQQUNLQUdFX1RZUEVfQ0xBVURFX1BMVUdJThAEKn0KElNhbmRib3hQb2xpY3lfVHlwZRIUChBUWVBFX1VOU1BFQ0lGSUVEEAASFgoSVFlQRV9JTlNFQ1VSRV9OT05FEAESHAoYVFlQRV9XT1JLU1BBQ0VfUkVBRFdSSVRFEAISGwoXVFlQRV9XT1JLU1BBQ0VfUkVBRE9OTFkQAypxCg9UaW1lb3V0QmVoYXZpb3ISIAocVElNRU9VVF9CRUhBVklPUl9VTlNQRUNJRklFRBAAEhsKF1RJTUVPVVRfQkVIQVZJT1JfQ0FOQ0VMEAESHwobVElNRU9VVF9CRUhBVklPUl9CQUNLR1JPVU5EEAIqeQoQU2hlbGxBYm9ydFJlYXNvbhIiCh5TSEVMTF9BQk9SVF9SRUFTT05fVU5TUEVDSUZJRUQQABIhCh1TSEVMTF9BQk9SVF9SRUFTT05fVVNFUl9BQk9SVBABEh4KGlNIRUxMX0FCT1JUX1JFQVNPTl9USU1FT1VUEAIqqgEKHEN1c3RvbVN1YmFnZW50UGVybWlzc2lvbk1vZGUSLworQ1VTVE9NX1NVQkFHRU5UX1BFUk1JU1NJT05fTU9ERV9VTlNQRUNJRklFRBAAEisKJ0NVU1RPTV9TVUJBR0VOVF9QRVJNSVNTSU9OX01PREVfREVGQVVMVBABEiwKKENVU1RPTV9TVUJBR0VOVF9QRVJNSVNTSU9OX01PREVfUkVBRE9OTFkQAiqVAQoKVG9kb1N0YXR1cxIbChdUT0RPX1NUQVRVU19VTlNQRUNJRklFRBAAEhcKE1RPRE9fU1RBVFVTX1BFTkRJTkcQARIbChdUT0RPX1NUQVRVU19JTl9QUk9HUkVTUxACEhkKFVRPRE9fU1RBVFVTX0NPTVBMRVRFRBADEhkKFVRPRE9fU1RBVFVTX0NBTkNFTExFRBAEKmYKCENsaWVudE9TEhkKFUNMSUVOVF9PU19VTlNQRUNJRklFRBAAEhUKEUNMSUVOVF9PU19XSU5ET1dTEAESEwoPQ0xJRU5UX09TX01BQ09TEAISEwoPQ0xJRU5UX09TX0xJTlVYEAMq7AEKHEFydGlmYWN0VXBsb2FkRGlzcGF0Y2hTdGF0dXMSLworQVJUSUZBQ1RfVVBMT0FEX0RJU1BBVENIX1NUQVRVU19VTlNQRUNJRklFRBAAEiwKKEFSVElGQUNUX1VQTE9BRF9ESVNQQVRDSF9TVEFUVVNfQUNDRVBURUQQARIsCihBUlRJRkFDVF9VUExPQURfRElTUEFUQ0hfU1RBVFVTX1JFSkVDVEVEEAISPwo7QVJUSUZBQ1RfVVBMT0FEX0RJU1BBVENIX1NUQVRVU19TS0lQUEVEX0FMUkVBRFlfSU5fUFJPR1JFU1MQAypXCgpGcmFtZV9LaW5kEhQKEEtJTkRfVU5TUEVDSUZJRUQQABIQCgxLSU5EX1JFUVVFU1QQARIRCg1LSU5EX1JFU1BPTlNFEAISDgoKS0lORF9FUlJPUhADKrACChdCdWdib3REZWVwbGlua0V2ZW50S2luZBIqCiZCVUdCT1RfREVFUExJTktfRVZFTlRfS0lORF9VTlNQRUNJRklFRBAAEiYKIkJVR0JPVF9ERUVQTElOS19FVkVOVF9LSU5EX0NMSUNLRUQQARIzCi9CVUdCT1RfREVFUExJTktfRVZFTlRfS0lORF9IQU5ETEVEX0RJQUxPR19TSE9XThACEjMKL0JVR0JPVF9ERUVQTElOS19FVkVOVF9LSU5EX0hBTkRMRURfQ0hBVF9DUkVBVEVEEAMSJAogQlVHQk9UX0RFRVBMSU5LX0VWRU5UX0tJTkRfRVJST1IQBBIxCi1CVUdCT1RfREVFUExJTktfRVZFTlRfS0lORF9IQU5ETEVEX0ZJWF9JTl9XRUIQBTKHBAoMQWdlbnRTZXJ2aWNlEkEKA1J1bhIcLmFnZW50LnYxLkFnZW50Q2xpZW50TWVzc2FnZRocLmFnZW50LnYxLkFnZW50U2VydmVyTWVzc2FnZRI/CgZSdW5TU0USFy5hZ2VudC52MS5CaWRpUmVxdWVzdElkGhwuYWdlbnQudjEuQWdlbnRTZXJ2ZXJNZXNzYWdlEkQKCU5hbWVBZ2VudBIaLmFnZW50LnYxLk5hbWVBZ2VudFJlcXVlc3QaGy5hZ2VudC52MS5OYW1lQWdlbnRSZXNwb25zZRJWCg9HZXRVc2FibGVNb2RlbHMSIC5hZ2VudC52MS5HZXRVc2FibGVNb2RlbHNSZXF1ZXN0GiEuYWdlbnQudjEuR2V0VXNhYmxlTW9kZWxzUmVzcG9uc2USaAoVR2V0RGVmYXVsdE1vZGVsRm9yQ2xpEiYuYWdlbnQudjEuR2V0RGVmYXVsdE1vZGVsRm9yQ2xpUmVxdWVzdBonLmFnZW50LnYxLkdldERlZmF1bHRNb2RlbEZvckNsaVJlc3BvbnNlEmsKFkdldEFsbG93ZWRNb2RlbEludGVudHMSJy5hZ2VudC52MS5HZXRBbGxvd2VkTW9kZWxJbnRlbnRzUmVxdWVzdBooLmFnZW50LnYxLkdldEFsbG93ZWRNb2RlbEludGVudHNSZXNwb25zZTK1CAoOQ29udHJvbFNlcnZpY2USTQoMUmVhZFRleHRGaWxlEh0uYWdlbnQudjEuUmVhZFRleHRGaWxlUmVxdWVzdBoeLmFnZW50LnYxLlJlYWRUZXh0RmlsZVJlc3BvbnNlElAKDVdyaXRlVGV4dEZpbGUSHi5hZ2VudC52MS5Xcml0ZVRleHRGaWxlUmVxdWVzdBofLmFnZW50LnYxLldyaXRlVGV4dEZpbGVSZXNwb25zZRJTCg5SZWFkQmluYXJ5RmlsZRIfLmFnZW50LnYxLlJlYWRCaW5hcnlGaWxlUmVxdWVzdBogLmFnZW50LnYxLlJlYWRCaW5hcnlGaWxlUmVzcG9uc2USVgoPV3JpdGVCaW5hcnlGaWxlEiAuYWdlbnQudjEuV3JpdGVCaW5hcnlGaWxlUmVxdWVzdBohLmFnZW50LnYxLldyaXRlQmluYXJ5RmlsZVJlc3BvbnNlEm4KF0dldFdvcmtzcGFjZUNoYW5nZXNIYXNoEiguYWdlbnQudjEuR2V0V29ya3NwYWNlQ2hhbmdlc0hhc2hSZXF1ZXN0GikuYWdlbnQudjEuR2V0V29ya3NwYWNlQ2hhbmdlc0hhc2hSZXNwb25zZRJxChhSZWZyZXNoR2l0aHViQWNjZXNzVG9rZW4SKS5hZ2VudC52MS5SZWZyZXNoR2l0aHViQWNjZXNzVG9rZW5SZXF1ZXN0GiouYWdlbnQudjEuUmVmcmVzaEdpdGh1YkFjY2Vzc1Rva2VuUmVzcG9uc2USawoWV2FybVJlbW90ZUFjY2Vzc1NlcnZlchInLmFnZW50LnYxLldhcm1SZW1vdGVBY2Nlc3NTZXJ2ZXJSZXF1ZXN0GiguYWdlbnQudjEuV2FybVJlbW90ZUFjY2Vzc1NlcnZlclJlc3BvbnNlElAKDUxpc3RBcnRpZmFjdHMSHi5hZ2VudC52MS5MaXN0QXJ0aWZhY3RzUmVxdWVzdBofLmFnZW50LnYxLkxpc3RBcnRpZmFjdHNSZXNwb25zZRJWCg9VcGxvYWRBcnRpZmFjdHMSIC5hZ2VudC52MS5VcGxvYWRBcnRpZmFjdHNSZXF1ZXN0GiEuYWdlbnQudjEuVXBsb2FkQXJ0aWZhY3RzUmVzcG9uc2USYgoTR2V0TWNwUmVmcmVzaFRva2VucxIkLmFnZW50LnYxLkdldE1jcFJlZnJlc2hUb2tlbnNSZXF1ZXN0GiUuYWdlbnQudjEuR2V0TWNwUmVmcmVzaFRva2Vuc1Jlc3BvbnNlEncKGlVwZGF0ZUVudmlyb25tZW50VmFyaWFibGVzEisuYWdlbnQudjEuVXBkYXRlRW52aXJvbm1lbnRWYXJpYWJsZXNSZXF1ZXN0GiwuYWdlbnQudjEuVXBkYXRlRW52aXJvbm1lbnRWYXJpYWJsZXNSZXNwb25zZTINCgtFeGVjU2VydmljZTJRCiJQcml2YXRlV29ya2VyQnJpZGdlRXh0ZXJuYWxTZXJ2aWNlEisKB0Nvbm5lY3QSDy5hZ2VudC52MS5GcmFtZRoPLmFnZW50LnYxLkZyYW1lMngKEExpZmVjeWNsZVNlcnZpY2USMQoNUmVzZXRJbnN0YW5jZRIPLmFnZW50LnYxLkVtcHR5Gg8uYWdlbnQudjEuRW1wdHkSMQoNUmVuZXdJbnN0YW5jZRIPLmFnZW50LnYxLkVtcHR5Gg8uYWdlbnQudjEuRW1wdHliBnByb3RvMw");
var ConversationActionSchema = /* @__PURE__ */ messageDesc(file_agent, 54);
var UserMessageActionSchema = /* @__PURE__ */ messageDesc(file_agent, 55);
var UserMessageSchema = /* @__PURE__ */ messageDesc(file_agent, 63);
var ConversationStateStructureSchema = /* @__PURE__ */ messageDesc(file_agent, 83);
var ModelDetailsSchema = /* @__PURE__ */ messageDesc(file_agent, 88);
var AgentRunRequestSchema = /* @__PURE__ */ messageDesc(file_agent, 91);
var ClientHeartbeatSchema = /* @__PURE__ */ messageDesc(file_agent, 114);
var AgentClientMessageSchema = /* @__PURE__ */ messageDesc(file_agent, 118);
var AgentServerMessageSchema = /* @__PURE__ */ messageDesc(file_agent, 119);
var GetUsableModelsRequestSchema = /* @__PURE__ */ messageDesc(file_agent, 122);
var GetUsableModelsResponseSchema = /* @__PURE__ */ messageDesc(file_agent, 123);
var BackgroundShellSpawnResultSchema = /* @__PURE__ */ messageDesc(file_agent, 147);
var WriteShellStdinResultSchema = /* @__PURE__ */ messageDesc(file_agent, 151);
var WriteShellStdinErrorSchema = /* @__PURE__ */ messageDesc(file_agent, 153);
var DeleteResultSchema = /* @__PURE__ */ messageDesc(file_agent, 187);
var DeleteRejectedSchema = /* @__PURE__ */ messageDesc(file_agent, 193);
var DiagnosticsResultSchema = /* @__PURE__ */ messageDesc(file_agent, 197);
var ExecClientMessageSchema = /* @__PURE__ */ messageDesc(file_agent, 244);
var FetchResultSchema = /* @__PURE__ */ messageDesc(file_agent, 246);
var FetchErrorSchema = /* @__PURE__ */ messageDesc(file_agent, 248);
var GrepResultSchema = /* @__PURE__ */ messageDesc(file_agent, 255);
var GrepErrorSchema = /* @__PURE__ */ messageDesc(file_agent, 256);
var GetBlobResultSchema = /* @__PURE__ */ messageDesc(file_agent, 268);
var SetBlobResultSchema = /* @__PURE__ */ messageDesc(file_agent, 270);
var KvClientMessageSchema = /* @__PURE__ */ messageDesc(file_agent, 272);
var LsResultSchema = /* @__PURE__ */ messageDesc(file_agent, 274);
var LsRejectedSchema = /* @__PURE__ */ messageDesc(file_agent, 279);
var McpResultSchema = /* @__PURE__ */ messageDesc(file_agent, 285);
var McpTextContentSchema = /* @__PURE__ */ messageDesc(file_agent, 287);
var McpToolResultContentItemSchema = /* @__PURE__ */ messageDesc(file_agent, 289);
var McpSuccessSchema = /* @__PURE__ */ messageDesc(file_agent, 290);
var McpErrorSchema = /* @__PURE__ */ messageDesc(file_agent, 291);
var McpToolDefinitionSchema = /* @__PURE__ */ messageDesc(file_agent, 306);
var ReadResultSchema = /* @__PURE__ */ messageDesc(file_agent, 313);
var ReadRejectedSchema = /* @__PURE__ */ messageDesc(file_agent, 316);
var RequestContextResultSchema = /* @__PURE__ */ messageDesc(file_agent, 336);
var RequestContextSuccessSchema = /* @__PURE__ */ messageDesc(file_agent, 337);
var RequestContextSchema = /* @__PURE__ */ messageDesc(file_agent, 347);
var SelectedImageSchema = /* @__PURE__ */ messageDesc(file_agent, 349);
var SelectedContextSchema = /* @__PURE__ */ messageDesc(file_agent, 373);
var ShellResultSchema = /* @__PURE__ */ messageDesc(file_agent, 389);
var ShellStreamSchema = /* @__PURE__ */ messageDesc(file_agent, 395);
var ShellRejectedSchema = /* @__PURE__ */ messageDesc(file_agent, 400);
var WriteResultSchema = /* @__PURE__ */ messageDesc(file_agent, 450);
var WriteRejectedSchema = /* @__PURE__ */ messageDesc(file_agent, 455);

// lib/models.ts
var CURSOR_BASE_URL = "https://api2.cursor.sh";
var CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
var GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
var DEFAULT_CONTEXT_WINDOW = 200000;
var DEFAULT_MAX_TOKENS = 64000;
var FALLBACK_MODELS = [
  { id: "auto", name: "Auto", reasoning: false, contextWindow: 200000, maxTokens: 64000 },
  { id: "composer-2", name: "Composer 2", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-4-sonnet", name: "Claude 4 Sonnet", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-4-sonnet-thinking", name: "Claude 4 Sonnet (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-4-opus", name: "Claude 4 Opus", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 256000, maxTokens: 64000 },
  { id: "gpt-5-codex", name: "GPT-5 Codex", reasoning: true, contextWindow: 256000, maxTokens: 64000 },
  { id: "gpt-4.1", name: "GPT-4.1", reasoning: false, contextWindow: 1e6, maxTokens: 32000 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1e6, maxTokens: 65536 }
];
async function getCursorModels(apiKey) {
  const discovered = await fetchCursorUsableModels(apiKey);
  if (discovered && discovered.length > 0) {
    updateCatalog(discovered);
    catalogListener?.(discovered);
    return discovered;
  }
  return cachedCatalog.length > 0 ? cachedCatalog : FALLBACK_MODELS;
}
function getFallbackModels() {
  return cachedCatalog.length > 0 ? cachedCatalog : FALLBACK_MODELS;
}
var cachedCatalog = [];
var catalogListener;
var variantGroups = new Map;
function setCatalogListener(listener) {
  catalogListener = listener;
}
function hydrateCatalog(models) {
  if (!Array.isArray(models) || models.length === 0 || cachedCatalog.length > 0)
    return;
  const valid = models.filter((m) => m && typeof m.id === "string" && m.id.length > 0);
  if (valid.length > 0)
    updateCatalog(valid);
}
function updateCatalog(models) {
  cachedCatalog = models;
  variantGroups = buildVariantGroups(models);
}
var COMPOSER_LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
var EFFORT_SUFFIXES = [
  ["extra-high", "xhigh"],
  ["xhigh", "xhigh"],
  ["minimal", "low"],
  ["medium", "medium"],
  ["ultra", "ultra"],
  ["none", "none"],
  ["high", "high"],
  ["low", "low"],
  ["max", "max"]
];
function parseVariantId(model) {
  let rest = model.id;
  let thinking = false;
  let fast = false;
  let effort;
  for (;; ) {
    if (!fast && rest.endsWith("-fast")) {
      fast = true;
      rest = rest.slice(0, -"-fast".length);
      continue;
    }
    if (!thinking && rest.endsWith("-thinking")) {
      thinking = true;
      rest = rest.slice(0, -"-thinking".length);
      continue;
    }
    if (effort === undefined) {
      const match = EFFORT_SUFFIXES.find(([suffix]) => rest.endsWith(`-${suffix}`));
      if (match) {
        effort = match[1];
        rest = rest.slice(0, -(match[0].length + 1));
        continue;
      }
    }
    break;
  }
  return { model, base: rest, thinking, fast, effort };
}
function buildVariantGroups(models) {
  const byGroup = new Map;
  for (const model of models) {
    const info = parseVariantId(model);
    const key = `${info.base}${info.fast ? "\x00fast" : ""}`;
    const list = byGroup.get(key);
    if (list)
      list.push(info);
    else
      byGroup.set(key, [info]);
  }
  const groups = new Map;
  for (const members of byGroup.values()) {
    if (members.length < 2)
      continue;
    const { base, fast } = members[0];
    const bareBase = members.find((m) => !m.thinking && !m.fast && m.effort === undefined && m.model.id === base);
    const collapsedId = bareBase ? base : fast ? `${base}-fast` : base;
    const nonThinking = members.filter((m) => !m.thinking);
    const namePool = nonThinking.length > 0 ? nonThinking : members;
    const defaultMember = pickDefaultMember(namePool);
    const offMember = nonThinking.find((m) => m.effort === "none") ?? defaultMember;
    const thinkingMembers = members.filter((m) => m.thinking);
    const effortPool = thinkingMembers.length > 0 ? thinkingMembers : nonThinking;
    const byEffort = new Map;
    for (const m of effortPool) {
      if (m.effort && m.effort !== "none" && !byEffort.has(m.effort)) {
        byEffort.set(m.effort, m.model.id);
      }
    }
    const thinkingDefaultId = thinkingMembers.find((m) => m.effort === undefined)?.model.id;
    groups.set(collapsedId, {
      id: collapsedId,
      members,
      defaultId: defaultMember.model.id,
      offId: offMember.model.id,
      byEffort,
      thinkingDefaultId
    });
  }
  return groups;
}
var EFFORT_DISPLAY_WORDS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  none: "None",
  ultra: "Ultra"
};
function nameCarriesOwnEffort(member) {
  if (!member.effort)
    return false;
  const word = EFFORT_DISPLAY_WORDS[member.effort];
  if (!word)
    return false;
  return new RegExp(`\\b${word}\\b`, "i").test(member.model.name);
}
var DEFAULT_EFFORT_PREFERENCE = ["medium", "high", "low", "xhigh", "max", "none"];
function pickDefaultMember(pool) {
  const unmarked = pool.filter((m) => !nameCarriesOwnEffort(m));
  if (unmarked.length > 0) {
    return unmarked.reduce((a, b) => b.model.name.length < a.model.name.length ? b : a);
  }
  for (const effort of DEFAULT_EFFORT_PREFERENCE) {
    const match = pool.find((m) => m.effort === effort);
    if (match)
      return match;
  }
  return pool.reduce((a, b) => b.model.name.length < a.model.name.length ? b : a);
}
function collapsedDisplayName(member) {
  if (!nameCarriesOwnEffort(member))
    return member.model.name;
  const word = EFFORT_DISPLAY_WORDS[member.effort];
  return member.model.name.replace(new RegExp(`\\s*\\b${word}\\b`, "i"), "").replace(/\s{2,}/g, " ").trim();
}
function collapseCursorModels(models) {
  const groups = buildVariantGroups(models);
  const groupByMemberId = new Map;
  for (const group of groups.values()) {
    for (const m of group.members)
      groupByMemberId.set(m.model.id, group);
  }
  const collapsed = [];
  const emitted = new Set;
  for (const model of models) {
    const group = groupByMemberId.get(model.id);
    if (!group) {
      collapsed.push({ ...model, variantCount: 1 });
      continue;
    }
    if (emitted.has(group.id))
      continue;
    emitted.add(group.id);
    const defaultMember = group.members.find((m) => m.model.id === group.defaultId);
    const levels = COMPOSER_LEVEL_ORDER.filter((l) => group.byEffort.has(l));
    collapsed.push({
      id: group.id,
      name: collapsedDisplayName(defaultMember),
      reasoning: group.members.some((m) => m.thinking) || levels.length > 0 || group.members.some((m) => m.model.reasoning),
      contextWindow: Math.max(...group.members.map((m) => m.model.contextWindow)),
      maxTokens: Math.max(...group.members.map((m) => m.model.maxTokens)),
      reasoningLevels: levels.length > 0 ? levels : undefined,
      variantCount: group.members.length
    });
  }
  return collapsed;
}
function resolveCursorModelId(modelId, reasoningEffort) {
  const group = variantGroups.get(modelId);
  if (!group)
    return modelId;
  const effort = normalizeEffort(reasoningEffort);
  if (effort === undefined)
    return group.defaultId;
  if (effort === "off")
    return group.offId;
  const exact = group.byEffort.get(effort);
  if (exact)
    return exact;
  const nearest = nearestLevel(effort, [...group.byEffort.keys()]);
  if (nearest)
    return group.byEffort.get(nearest);
  return group.thinkingDefaultId ?? group.defaultId;
}
function normalizeEffort(effort) {
  if (typeof effort !== "string" || effort.length === 0)
    return;
  const lower = effort.toLowerCase();
  if (lower === "off" || lower === "none")
    return "off";
  if (lower === "minimal")
    return "low";
  if (lower === "extra-high")
    return "xhigh";
  return COMPOSER_LEVEL_ORDER.includes(lower) ? lower : undefined;
}
function nearestLevel(target, available) {
  const targetIdx = COMPOSER_LEVEL_ORDER.indexOf(target);
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of COMPOSER_LEVEL_ORDER) {
    if (!available.includes(level))
      continue;
    const distance = Math.abs(COMPOSER_LEVEL_ORDER.indexOf(level) - targetIdx);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}
async function fetchCursorUsableModels(apiKey) {
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const responseBuffer = await fetchViaHttp2(body, apiKey);
    if (!responseBuffer)
      return null;
    const decoded = decodeGetUsableModelsResponse(responseBuffer);
    if (!decoded)
      return null;
    const models = decoded.models;
    if (!Array.isArray(models) || models.length === 0)
      return null;
    return normalizeModels(models);
  } catch {
    return null;
  }
}
function fetchViaHttp2(body, apiKey) {
  return new Promise((resolve) => {
    const client = http2.connect(CURSOR_BASE_URL);
    const chunks = [];
    let statusOk = false;
    const timeout = setTimeout(() => {
      client.destroy();
      resolve(null);
    }, 5000);
    client.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    const stream = client.request({
      ":method": "POST",
      ":path": GET_USABLE_MODELS_PATH,
      "content-type": "application/proto",
      te: "trailers",
      authorization: `Bearer ${apiKey}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_CLIENT_VERSION,
      "x-cursor-client-type": "cli"
    });
    stream.on("response", (headers) => {
      const status = headers[":status"];
      statusOk = typeof status === "number" && status >= 200 && status < 300;
    });
    stream.on("data", (chunk) => {
      chunks.push(chunk);
    });
    stream.on("end", () => {
      clearTimeout(timeout);
      client.close();
      if (!statusOk) {
        resolve(null);
        return;
      }
      const result = Buffer.concat(chunks);
      resolve(new Uint8Array(result));
    });
    stream.on("error", () => {
      clearTimeout(timeout);
      client.close();
      resolve(null);
    });
    stream.write(body);
    stream.end();
  });
}
function decodeGetUsableModelsResponse(payload) {
  if (payload.length === 0)
    return null;
  const framedBody = decodeConnectUnaryBody(payload);
  if (framedBody) {
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {}
  }
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    return null;
  }
}
function decodeConnectUnaryBody(payload) {
  if (payload.length < 5)
    return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset];
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length)
      return null;
    if ((flags & 1) !== 0)
      return null;
    if (!((flags & 2) !== 0)) {
      return payload.subarray(offset + 5, frameEnd);
    }
    offset = frameEnd;
  }
  return null;
}
function normalizeModels(models) {
  const byId = new Map;
  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (normalized)
      byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function normalizeSingleModel(model) {
  if (!model || typeof model !== "object")
    return null;
  const m = model;
  const id = typeof m.modelId === "string" ? m.modelId.trim() : "";
  if (!id)
    return null;
  const name = pickDisplayName(m, id);
  const reasoning = Boolean(m.thinkingDetails);
  return {
    id,
    name,
    reasoning,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS
  };
}
function pickDisplayName(model, fallbackId) {
  const candidates = [
    model.displayName,
    model.displayNameShort,
    model.displayModelId
  ];
  const aliases = model.aliases;
  if (Array.isArray(aliases)) {
    candidates.push(...aliases);
  }
  candidates.push(fallbackId);
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed)
        return trimmed;
    }
  }
  return fallbackId;
}

// lib/cursor-fetch.ts
import * as http from "node:http";
import * as http22 from "node:http2";
import { createHash } from "node:crypto";
var CURSOR_API_URL = "https://api2.cursor.sh";
var CURSOR_CLIENT_VERSION2 = "cli-2026.02.13-41ac335";
var CONNECT_END_STREAM_FLAG = 2;
var activeSessions = new Map;
function registerBridge(bridge, keys) {
  bridge.keys = keys;
  for (const k of keys)
    activeSessions.set(k, bridge);
}
function deleteBridge(bridge) {
  for (const k of bridge.keys) {
    if (activeSessions.get(k) === bridge)
      activeSessions.delete(k);
  }
}
function bridgeKeysFor(sessionKey, execs) {
  const keys = [sessionKey];
  for (const e of execs) {
    if (e.toolCallId)
      keys.push(`tc:${e.toolCallId}`);
  }
  return keys;
}
var sessionGcTimer;
var SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
function destroySession(session) {
  clearInterval(session.heartbeatTimer);
  try {
    session.h2Stream.close();
  } catch {}
}
function gcStaleSessions() {
  const now = Date.now();
  for (const session of new Set(activeSessions.values())) {
    if (now - session.lastActiveAt > SESSION_IDLE_TIMEOUT_MS) {
      destroySession(session);
      deleteBridge(session);
    }
  }
}
var proxyServer;
var proxyPort;
function startProxy(getAccessToken, logger) {
  if (proxyServer && proxyPort)
    return Promise.resolve(proxyPort);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url?.includes("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (req.method === "POST") {
        try {
          const bodyStr = await readBody(req);
          const body = JSON.parse(bodyStr);
          const accessToken = await getAccessToken();
          logger.debug(`Cursor proxy: model=${body.model}, stream=${body.stream}, messages=${body.messages?.length}`);
          handleChatCompletion(body, accessToken, res, logger);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Cursor proxy error:", message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message, type: "server_error", code: "internal_error" } }));
        }
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        proxyPort = addr.port;
        proxyServer = server;
        if (!sessionGcTimer) {
          sessionGcTimer = setInterval(gcStaleSessions, 60000);
          sessionGcTimer.unref?.();
        }
        logger.info(`Cursor proxy started on port ${proxyPort}`);
        resolve(addr.port);
      } else {
        reject(new Error("Failed to bind proxy to a port"));
      }
    });
    server.on("error", reject);
  });
}
function stopProxy() {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = undefined;
    proxyPort = undefined;
  }
  if (sessionGcTimer) {
    clearInterval(sessionGcTimer);
    sessionGcTimer = undefined;
  }
  for (const session of new Set(activeSessions.values())) {
    destroySession(session);
  }
  activeSessions.clear();
  dropSharedH2Session();
}
function createProxyFetch() {
  return async (input, init) => {
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.delete("authorization");
        init.headers.delete("Authorization");
      } else if (Array.isArray(init.headers)) {
        init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization");
      } else {
        delete init.headers["authorization"];
        delete init.headers["Authorization"];
      }
    }
    return fetch(input, init);
  };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
function handleChatCompletion(body, accessToken, res, logger) {
  const { systemPrompt, userText, images, turns, toolResults } = parseMessages(body.messages);
  const modelId = resolveCursorModelId(body.model, body.reasoning_effort);
  if (modelId !== body.model) {
    logger.debug(`Cursor proxy: resolved ${body.model} (effort=${body.reasoning_effort ?? "default"}) -> ${modelId}`);
  }
  const tools = body.tools ?? [];
  if (!userText && toolResults.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
    return;
  }
  const sessionKey = deriveSessionKey(modelId, body.messages);
  let activeSession;
  for (const r of toolResults) {
    if (!r.toolCallId)
      continue;
    const b = activeSessions.get(`tc:${r.toolCallId}`);
    if (b) {
      activeSession = b;
      break;
    }
  }
  if (!activeSession)
    activeSession = activeSessions.get(sessionKey);
  if (activeSession && toolResults.length > 0) {
    deleteBridge(activeSession);
    resumeWithToolResults(activeSession, toolResults, modelId, sessionKey, res);
    return;
  }
  if (activeSession) {
    destroySession(activeSession);
    deleteBridge(activeSession);
  }
  let effectiveUserText = userText;
  if (!effectiveUserText && toolResults.length > 0) {
    effectiveUserText = "Please continue based on the tool results above.";
    logger.warn("Cursor proxy: rebuilding conversation after bridge expiry; using synthetic continuation prompt");
  }
  if (turns.length > 0) {
    const historyLines = [];
    for (const turn of turns) {
      if (turn.userText)
        historyLines.push(`User: ${turn.userText}`);
      if (turn.assistantText)
        historyLines.push(`Assistant: ${turn.assistantText}`);
      for (const tc of turn.toolCalls) {
        historyLines.push(`Assistant tool_call: ${tc.toolName}(${tc.argsJson})`);
        if (tc.resultText !== undefined) {
          historyLines.push(`Tool result: ${tc.resultText}`);
        }
      }
    }
    if (historyLines.length > 0) {
      effectiveUserText = `[Previous conversation]
${historyLines.join(`
`)}

[Current message]
${effectiveUserText}`;
    }
  }
  const mcpTools = buildMcpToolDefinitions(tools);
  const isStreaming = body.stream === true;
  const isUtilityCall = !isStreaming && mcpTools.length === 0;
  const mode = isUtilityCall ? AGENT_MODE_ASK : undefined;
  let promptSystem = systemPrompt;
  let promptUser = effectiveUserText;
  if (isUtilityCall && systemPrompt) {
    promptUser = `<instructions>
${systemPrompt}
</instructions>

${effectiveUserText}

(Follow <instructions> exactly. Do NOT attempt to execute the task yourself — no tools.)`;
    promptSystem = "";
  }
  const payload = buildCursorRequest(modelId, promptSystem, promptUser, images, mode);
  payload.mcpTools = mcpTools;
  if (isStreaming) {
    handleStreaming(payload, accessToken, modelId, sessionKey, res);
  } else {
    handleNonStreaming(payload, accessToken, modelId, res, logger);
  }
}
function extractContent(content) {
  if (typeof content === "string")
    return { text: content, images: [] };
  if (content == null)
    return { text: "", images: [] };
  if (Array.isArray(content)) {
    const textParts = [];
    const images = [];
    for (const part of content) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (typeof part === "object" && part !== null) {
        const p = part;
        if (p.type === "text" && typeof p.text === "string") {
          textParts.push(p.text);
        } else if (p.type === "image_url" && p.image_url?.url) {
          const parsed = parseDataUrl(p.image_url.url);
          if (parsed)
            images.push(parsed);
        } else if (p.type === "image" && p.image) {
          const url = typeof p.image === "string" ? p.image : p.image.url;
          if (url) {
            const parsed = parseDataUrl(url);
            if (parsed)
              images.push(parsed);
          }
        }
      }
    }
    return { text: textParts.join(""), images };
  }
  return { text: String(content), images: [] };
}
function parseDataUrl(url) {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        mimeType: match[1],
        data: new Uint8Array(Buffer.from(match[2], "base64"))
      };
    }
  }
  return null;
}
function parseMessages(messages) {
  let systemPrompt = "You are a helpful assistant.";
  const turns = [];
  const toolResults = [];
  let images = [];
  const systemParts = messages.filter((m) => m.role === "system").map((m) => extractContent(m.content).text);
  if (systemParts.length > 0)
    systemPrompt = systemParts.join(`
`);
  const nonSystem = messages.filter((m) => m.role !== "system");
  let current = null;
  const flush = () => {
    if (current && (current.userText || current.assistantText || current.toolCalls.length > 0)) {
      turns.push(current);
    }
    current = null;
  };
  const findToolCall = (id) => {
    if (!id)
      return;
    if (current) {
      const hit = current.toolCalls.find((c) => c.toolCallId === id);
      if (hit)
        return hit;
    }
    for (let i = turns.length - 1;i >= 0; i--) {
      const hit = turns[i].toolCalls.find((c) => c.toolCallId === id);
      if (hit)
        return hit;
    }
    return;
  };
  for (const msg of nonSystem) {
    if (msg.role === "user") {
      flush();
      const parsed = extractContent(msg.content);
      current = { userText: parsed.text, assistantText: "", toolCalls: [] };
      images = parsed.images;
    } else if (msg.role === "assistant") {
      if (!current)
        current = { userText: "", assistantText: "", toolCalls: [] };
      const text = extractContent(msg.content).text;
      if (text) {
        current.assistantText = current.assistantText ? `${current.assistantText}
${text}` : text;
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || tc.type !== "function" || !tc.function)
            continue;
          current.toolCalls.push({
            toolCallId: tc.id || crypto.randomUUID(),
            toolName: tc.function.name,
            argsJson: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {})
          });
        }
      }
    } else if (msg.role === "tool") {
      const id = msg.tool_call_id ?? "";
      const resultText = extractContent(msg.content).text;
      toolResults.push({ toolCallId: id, content: resultText });
      const target = findToolCall(id);
      if (target) {
        target.resultText = resultText;
      }
    }
  }
  let lastUserText = "";
  if (current) {
    if (current.userText && current.toolCalls.length === 0 && !current.assistantText) {
      lastUserText = current.userText;
      current = null;
    } else {
      flush();
      if (toolResults.length === 0 && turns.length > 0) {
        const last = turns.pop();
        lastUserText = last.userText;
      }
    }
  }
  return { systemPrompt, userText: lastUserText, images, turns, toolResults };
}
var CURSOR_RESERVED_TOOL_NAMES = new Set([
  "Task",
  "TodoWrite",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch"
]);
var RESERVED_TOOL_PREFIX = "alma_";
function encodeToolName(name) {
  return CURSOR_RESERVED_TOOL_NAMES.has(name) ? RESERVED_TOOL_PREFIX + name : name;
}
function decodeToolName(name) {
  if (!name.startsWith(RESERVED_TOOL_PREFIX))
    return name;
  const stripped = name.slice(RESERVED_TOOL_PREFIX.length);
  return CURSOR_RESERVED_TOOL_NAMES.has(stripped) ? stripped : name;
}
function buildMcpToolDefinitions(tools) {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {}, required: [] };
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    const wireName = encodeToolName(fn.name);
    return create(McpToolDefinitionSchema, { name: wireName, description: fn.description || "", providerIdentifier: "alma", toolName: wireName, inputSchema });
  });
}
function decodeMcpArgValue(value) {
  try {
    return toJson(ValueSchema, fromBinary(ValueSchema, value));
  } catch {}
  return new TextDecoder().decode(value);
}
function decodeMcpArgsMap(args) {
  const decoded = {};
  for (const [key, value] of Object.entries(args))
    decoded[key] = decodeMcpArgValue(value);
  return decoded;
}
var AGENT_MODE_ASK = 2;
function buildCursorRequest(modelId, systemPrompt, userText, images, mode) {
  const blobStore = new Map;
  const systemJson = JSON.stringify({ role: "system", content: systemPrompt });
  const systemBytes = new TextEncoder().encode(systemJson);
  const systemBlobId = new Uint8Array(createHash("sha256").update(systemBytes).digest());
  blobStore.set(Buffer.from(systemBlobId).toString("hex"), systemBytes);
  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [systemBlobId],
    turns: [],
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
    ...mode !== undefined && { mode }
  });
  const userMessage = create(UserMessageSchema, { text: userText, messageId: crypto.randomUUID() });
  if (images.length > 0) {
    const selectedImages = images.map((img) => create(SelectedImageSchema, {
      uuid: crypto.randomUUID(),
      mimeType: img.mimeType,
      dataOrBlobId: { case: "data", value: img.data }
    }));
    userMessage.selectedContext = create(SelectedContextSchema, { selectedImages });
  }
  const userMsgBytes = toBinary(UserMessageSchema, userMessage);
  blobStore.set(Buffer.from(userMsgBytes).toString("hex"), userMsgBytes);
  const action = create(ConversationActionSchema, { action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) } });
  const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
  const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId: crypto.randomUUID() });
  const clientMessage = create(AgentClientMessageSchema, { message: { case: "runRequest", value: runRequest } });
  return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [] };
}
function frameConnectMessage(data, flags = 0) {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}
function parseConnectEndStream(data) {
  try {
    const p = JSON.parse(new TextDecoder().decode(data));
    if (p?.error)
      return new Error(formatConnectError(p.error));
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}
function formatConnectError(error) {
  const code = error.code ?? "unknown";
  let message = error.message ?? "Unknown";
  const details = Array.isArray(error.details) ? error.details : [];
  for (const d of details) {
    const debug = d?.debug;
    const dd = debug?.details;
    if (dd?.title || dd?.detail) {
      message = [dd.title, dd.detail].filter(Boolean).join(" — ");
      const buttons = Array.isArray(dd.buttons) ? dd.buttons : [];
      const urls = buttons.map((b) => b?.url?.url).filter(Boolean);
      if (urls.length > 0)
        message += ` (see ${urls.join(", ")})`;
      if (buttons.some((b) => b?.dashboardAction)) {
        message += " — open Cursor IDE, select this model once and accept the prompt, then retry here.";
      }
      break;
    }
    if (typeof debug?.error === "string" && debug.error) {
      message = message === "Error" ? debug.error : `${message} (${debug.error})`;
    }
  }
  return `Connect error ${code}: ${message}`;
}
function makeHeartbeatBytes() {
  return frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) } })));
}
var sharedH2Session;
var sharedH2KeepAlive;
function dropSharedH2Session() {
  if (sharedH2KeepAlive) {
    clearInterval(sharedH2KeepAlive);
    sharedH2KeepAlive = undefined;
  }
  const s = sharedH2Session;
  sharedH2Session = undefined;
  if (s) {
    try {
      s.close();
    } catch {}
  }
}
function getSharedH2Session() {
  if (sharedH2Session && !sharedH2Session.closed && !sharedH2Session.destroyed) {
    return sharedH2Session;
  }
  if (sharedH2Session)
    dropSharedH2Session();
  const session = http22.connect(CURSOR_API_URL);
  sharedH2Session = session;
  const forget = () => {
    if (sharedH2Session === session)
      dropSharedH2Session();
  };
  session.on("error", forget);
  session.on("close", forget);
  session.on("goaway", forget);
  sharedH2KeepAlive = setInterval(() => {
    if (session.closed || session.destroyed) {
      forget();
      return;
    }
    try {
      session.ping(() => {});
    } catch {
      forget();
    }
  }, 30000);
  sharedH2KeepAlive.unref?.();
  return session;
}
function openH2Stream(session, accessToken) {
  return session.request({
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION2,
    "x-cursor-client-type": "cli",
    "x-request-id": crypto.randomUUID()
  });
}
function createH2Stream(accessToken) {
  let session = getSharedH2Session();
  try {
    return { client: session, stream: openH2Stream(session, accessToken) };
  } catch {
    dropSharedH2Session();
    session = getSharedH2Session();
    return { client: session, stream: openH2Stream(session, accessToken) };
  }
}
function processServerMessage(msg, blobStore, mcpTools, sendFrame, state, onText, onMcpExec) {
  const c = msg.message.case;
  if (c === "interactionUpdate") {
    const u = msg.message.value.message;
    if (u?.case === "textDelta" && u.value.text)
      onText(u.value.text, false);
    else if (u?.case === "thinkingDelta" && u.value.text)
      onText(u.value.text, true);
  } else if (c === "kvServerMessage")
    handleKvMessage(msg.message.value, blobStore, sendFrame);
  else if (c === "execServerMessage")
    handleExecMessage(msg.message.value, mcpTools, sendFrame, onMcpExec);
}
function handleKvMessage(kv, blobStore, sendFrame) {
  if (kv.message.case === "getBlobArgs") {
    const blobData = blobStore.get(Buffer.from(kv.message.value.blobId).toString("hex"));
    const r = create(KvClientMessageSchema, { id: kv.id, message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) } });
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: r } }))));
  } else if (kv.message.case === "setBlobArgs") {
    blobStore.set(Buffer.from(kv.message.value.blobId).toString("hex"), kv.message.value.blobData);
    const r = create(KvClientMessageSchema, { id: kv.id, message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) } });
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: r } }))));
  }
}
function handleExecMessage(exec, mcpTools, sendFrame, onMcpExec) {
  const c = exec.message.case;
  const R = mcpTools.length > 0 ? "Tool not available in this environment. Use the MCP tools provided instead." : "Tool not available in this environment. Do not retry tools — answer directly in your final message.";
  if (c === "requestContextArgs") {
    const ctx = create(RequestContextSchema, { rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [], projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [] });
    sendExec(exec, "requestContextResult", create(RequestContextResultSchema, { result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: ctx }) } }), sendFrame);
  } else if (c === "mcpArgs") {
    const a = exec.message.value;
    onMcpExec({ execId: exec.execId, execMsgId: exec.id, toolCallId: a.toolCallId || crypto.randomUUID(), toolName: decodeToolName(a.toolName || a.name), decodedArgs: JSON.stringify(decodeMcpArgsMap(a.args ?? {})) });
  } else if (c === "readArgs")
    sendExec(exec, "readResult", create(ReadResultSchema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
  else if (c === "lsArgs")
    sendExec(exec, "lsResult", create(LsResultSchema, { result: { case: "rejected", value: create(LsRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
  else if (c === "grepArgs")
    sendExec(exec, "grepResult", create(GrepResultSchema, { result: { case: "error", value: create(GrepErrorSchema, { error: R }) } }), sendFrame);
  else if (c === "writeArgs")
    sendExec(exec, "writeResult", create(WriteResultSchema, { result: { case: "rejected", value: create(WriteRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
  else if (c === "deleteArgs")
    sendExec(exec, "deleteResult", create(DeleteResultSchema, { result: { case: "rejected", value: create(DeleteRejectedSchema, { path: exec.message.value.path, reason: R }) } }), sendFrame);
  else if (c === "shellArgs") {
    const a = exec.message.value;
    sendExec(exec, "shellResult", create(ShellResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: a.command ?? "", workingDirectory: a.workingDirectory ?? "", reason: R, isReadonly: false }) } }), sendFrame);
  } else if (c === "shellStreamArgs") {
    const a = exec.message.value;
    sendExec(exec, "shellStream", create(ShellStreamSchema, { event: { case: "rejected", value: create(ShellRejectedSchema, { command: a.command ?? "", workingDirectory: a.workingDirectory ?? "", reason: R, isReadonly: false }) } }), sendFrame);
  } else if (c === "backgroundShellSpawnArgs") {
    const a = exec.message.value;
    sendExec(exec, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: a.command ?? "", workingDirectory: a.workingDirectory ?? "", reason: R, isReadonly: false }) } }), sendFrame);
  } else if (c === "writeShellStdinArgs")
    sendExec(exec, "writeShellStdinResult", create(WriteShellStdinResultSchema, { result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: R }) } }), sendFrame);
  else if (c === "fetchArgs")
    sendExec(exec, "fetchResult", create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { url: exec.message.value.url ?? "", error: R }) } }), sendFrame);
  else if (c === "diagnosticsArgs")
    sendExec(exec, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
  else {
    const m = { listMcpResourcesExecArgs: "listMcpResourcesExecResult", readMcpResourceExecArgs: "readMcpResourceExecResult", recordScreenArgs: "recordScreenResult", computerUseArgs: "computerUseResult" };
    if (m[c])
      sendExec(exec, m[c], create(McpResultSchema, {}), sendFrame);
  }
}
function sendExec(exec, mc, v, sendFrame) {
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: create(ExecClientMessageSchema, { id: exec.id, execId: exec.execId, message: { case: mc, value: v } }) } }))));
}
function deriveSessionKey(modelId, messages) {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const text = extractContent(first).text;
  return createHash("sha256").update(`${modelId}:${text.slice(0, 200)}`).digest("hex").slice(0, 16);
}
function handleStreaming(payload, accessToken, modelId, sessionKey, res) {
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.on("error", () => {
    closed = true;
  });
  const sse = (d) => {
    if (!closed)
      try {
        res.write(`data: ${JSON.stringify(d)}

`);
      } catch {
        closed = true;
      }
  };
  const done = () => {
    if (!closed)
      try {
        res.write(`data: [DONE]

`);
      } catch {
        closed = true;
      }
  };
  const end = () => {
    if (closed)
      return;
    closed = true;
    try {
      res.end();
    } catch {}
  };
  const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] });
  const state = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
  let mcpExecReceived = false;
  const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
  h2Stream.write(frameConnectMessage(payload.requestBytes));
  const heartbeatTimer = setInterval(() => {
    if (!h2Stream.closed && !h2Stream.destroyed)
      h2Stream.write(makeHeartbeatBytes());
  }, 5000);
  const processData = buildStreamProcessor(h2Stream, payload, state, chunk, sse, done, end, h2Client, heartbeatTimer, sessionKey, () => {
    mcpExecReceived = true;
  });
  h2Stream.on("data", processData);
  h2Stream.on("end", () => {
    clearInterval(heartbeatTimer);
    if (!mcpExecReceived) {
      if (state.thinkingActive)
        sse(chunk({ content: "</think>" }));
      sse(chunk({}, "stop"));
      done();
      end();
    }
  });
  h2Stream.on("error", () => {
    clearInterval(heartbeatTimer);
    try {
      h2Stream.close();
    } catch {}
    if (!mcpExecReceived) {
      sse(chunk({}, "stop"));
      done();
      end();
    }
  });
}
function buildStreamProcessor(h2Stream, payload, state, chunk, sse, done, end, h2Client, heartbeatTimer, sessionKey, onMcpFlag) {
  let pendingBuffer = Buffer.alloc(0);
  return (incoming) => {
    pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
    while (pendingBuffer.length >= 5) {
      const flags = pendingBuffer[0];
      const msgLen = pendingBuffer.readUInt32BE(1);
      if (pendingBuffer.length < 5 + msgLen)
        break;
      const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
      pendingBuffer = pendingBuffer.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) {
        const e = parseConnectEndStream(messageBytes);
        if (e)
          sse(chunk({ content: `
[Error: ${e.message}]` }));
        continue;
      }
      try {
        processServerMessage(fromBinary(AgentServerMessageSchema, messageBytes), payload.blobStore, payload.mcpTools, (data) => {
          if (!h2Stream.closed && !h2Stream.destroyed)
            h2Stream.write(data);
        }, state, (text, isThinking) => {
          if (isThinking) {
            if (!state.thinkingActive) {
              state.thinkingActive = true;
              sse(chunk({ role: "assistant", content: "<think>" }));
            }
            sse(chunk({ content: text }));
          } else {
            if (state.thinkingActive) {
              state.thinkingActive = false;
              sse(chunk({ content: "</think>" }));
            }
            sse(chunk({ content: text }));
          }
        }, (exec) => {
          state.pendingExecs.push(exec);
          onMcpFlag();
          if (state.thinkingActive) {
            sse(chunk({ content: "</think>" }));
            state.thinkingActive = false;
          }
          sse(chunk({ tool_calls: [{ index: state.toolCallIndex++, id: exec.toolCallId, type: "function", function: { name: exec.toolName, arguments: exec.decodedArgs } }] }));
          const bridge = { h2Client, h2Stream, heartbeatTimer, blobStore: payload.blobStore, mcpTools: payload.mcpTools, pendingExecs: state.pendingExecs, lastActiveAt: Date.now(), keys: [] };
          registerBridge(bridge, bridgeKeysFor(sessionKey, state.pendingExecs));
          sse(chunk({}, "tool_calls"));
          done();
          end();
        });
      } catch {}
    }
  };
}
function resumeWithToolResults(session, toolResults, modelId, sessionKey, res) {
  const { h2Client, h2Stream, heartbeatTimer, blobStore, mcpTools, pendingExecs } = session;
  for (const exec of pendingExecs) {
    const result = toolResults.find((r) => r.toolCallId === exec.toolCallId);
    const mcpResult = result ? create(McpResultSchema, { result: { case: "success", value: create(McpSuccessSchema, { content: [create(McpToolResultContentItemSchema, { content: { case: "text", value: create(McpTextContentSchema, { text: result.content }) } })], isError: false }) } }) : create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: "Tool result not provided" }) } });
    const cm = create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: create(ExecClientMessageSchema, { id: exec.execMsgId, execId: exec.execId, message: { case: "mcpResult", value: mcpResult } }) } });
    if (!h2Stream.closed && !h2Stream.destroyed)
      h2Stream.write(frameConnectMessage(toBinary(AgentClientMessageSchema, cm)));
  }
  h2Stream.removeAllListeners("data");
  h2Stream.removeAllListeners("end");
  h2Stream.removeAllListeners("error");
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.on("error", () => {
    closed = true;
  });
  const sse = (d) => {
    if (!closed)
      try {
        res.write(`data: ${JSON.stringify(d)}

`);
      } catch {
        closed = true;
      }
  };
  const done = () => {
    if (!closed)
      try {
        res.write(`data: [DONE]

`);
      } catch {
        closed = true;
      }
  };
  const end = () => {
    if (closed)
      return;
    closed = true;
    try {
      res.end();
    } catch {}
  };
  const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] });
  const state = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
  let mcpExecReceived = false;
  const processData = buildStreamProcessor(h2Stream, { blobStore, mcpTools }, state, chunk, sse, done, end, h2Client, heartbeatTimer, sessionKey, () => {
    mcpExecReceived = true;
  });
  h2Stream.on("data", processData);
  h2Stream.on("end", () => {
    clearInterval(heartbeatTimer);
    if (!mcpExecReceived) {
      if (state.thinkingActive)
        sse(chunk({ content: "</think>" }));
      sse(chunk({}, "stop"));
      done();
      end();
    }
  });
  h2Stream.on("error", () => {
    clearInterval(heartbeatTimer);
    try {
      h2Stream.close();
    } catch {}
    if (!mcpExecReceived) {
      sse(chunk({}, "stop"));
      done();
      end();
    }
  });
}
function handleNonStreaming(payload, accessToken, modelId, res, logger) {
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const { client: h2Client, stream: h2Stream } = createH2Stream(accessToken);
  h2Stream.write(frameConnectMessage(payload.requestBytes));
  const heartbeatTimer = setInterval(() => {
    if (!h2Stream.closed && !h2Stream.destroyed)
      h2Stream.write(makeHeartbeatBytes());
  }, 5000);
  let fullText = "";
  let pendingBuffer = Buffer.alloc(0);
  const collectedToolCalls = [];
  let responded = false;
  let endStreamError = null;
  const state = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] };
  const cleanup = () => {
    clearInterval(heartbeatTimer);
    try {
      h2Stream.close();
    } catch {}
  };
  res.on("error", () => {});
  res.on("close", () => {
    if (!responded) {
      responded = true;
      cleanup();
    }
  });
  const respond = (finishReason, errMessage) => {
    if (responded)
      return;
    responded = true;
    cleanup();
    if (res.destroyed || res.headersSent)
      return;
    res.writeHead(200, { "Content-Type": "application/json" });
    const message = { role: "assistant", content: fullText || null };
    if (collectedToolCalls.length > 0) {
      message.tool_calls = collectedToolCalls.map((tc, i) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argsJson }
      }));
    }
    if (errMessage) {
      message.content = (message.content || "") + `
[Error: ${errMessage}]`;
    }
    res.end(JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }));
  };
  h2Stream.on("data", (incoming) => {
    pendingBuffer = Buffer.concat([pendingBuffer, incoming]);
    while (pendingBuffer.length >= 5) {
      const flags = pendingBuffer[0];
      const msgLen = pendingBuffer.readUInt32BE(1);
      if (pendingBuffer.length < 5 + msgLen)
        break;
      const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
      pendingBuffer = pendingBuffer.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) {
        const e = parseConnectEndStream(messageBytes);
        if (e) {
          endStreamError = e;
          logger.error("Cursor proxy non-stream end-stream error:", e.message);
        }
        continue;
      }
      try {
        processServerMessage(fromBinary(AgentServerMessageSchema, messageBytes), payload.blobStore, payload.mcpTools, (data) => {
          if (!h2Stream.closed && !h2Stream.destroyed)
            h2Stream.write(data);
        }, state, (text, isThinking) => {
          if (!isThinking)
            fullText += text;
        }, (exec) => {
          collectedToolCalls.push({
            id: exec.toolCallId,
            name: exec.toolName,
            argsJson: exec.decodedArgs
          });
        });
      } catch (err) {
        logger.warn("Cursor proxy non-stream parse error:", err);
      }
    }
  });
  h2Stream.on("end", () => {
    if (collectedToolCalls.length > 0)
      respond("tool_calls");
    else if (endStreamError)
      respond("error", endStreamError.message);
    else
      respond("stop");
  });
  h2Stream.on("error", (err) => {
    logger.error("Cursor proxy non-stream h2 error:", err);
    respond("error", err instanceof Error ? err.message : String(err));
  });
  const turnDeadline = setTimeout(() => {
    logger.warn("Cursor proxy non-stream turn exceeded 120s, responding with partial text");
    respond("stop");
  }, 120000);
  turnDeadline.unref?.();
  res.on("close", () => clearTimeout(turnDeadline));
}

// main.ts
var DUMMY_API_KEY = "cursor-proxy";
var MODELS_CACHE_KEY = "cursor-model-catalog-v1";
async function activate(context) {
  const { logger, storage, providers, commands, ui } = context;
  logger.info("Cursor Auth plugin activating...");
  const tokenStore = new TokenStore(storage.secrets, logger);
  await tokenStore.initialize();
  setCatalogListener((models) => {
    storage.local.set(MODELS_CACHE_KEY, models).catch((err) => logger.warn("Failed to persist Cursor model catalog:", err));
  });
  const catalogHydration = (async () => {
    try {
      const persisted = await storage.local.get(MODELS_CACHE_KEY);
      hydrateCatalog(persisted);
      if (Array.isArray(persisted) && persisted.length > 0) {
        logger.info(`Hydrated ${persisted.length} Cursor models from storage`);
      }
    } catch (err) {
      logger.warn("Failed to hydrate Cursor model catalog from storage:", err);
    }
  })();
  const toProviderModels = (models) => collapseCursorModels(models).map((model) => ({
    id: model.id,
    name: model.name,
    description: model.variantCount > 1 ? `Cursor: ${model.name} — ${model.variantCount} effort variants merged; the thinking selector picks the tier` : `Cursor: ${model.name}${model.reasoning ? " (reasoning)" : ""}`,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    capabilities: {
      temperature: true,
      streaming: true,
      reasoning: model.reasoning,
      attachment: false,
      functionCalling: true,
      ...model.reasoningLevels ? { reasoningLevels: model.reasoningLevels } : {},
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: false
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false
      }
    }
  }));
  let currentProxyPort;
  const ensureProxy = async () => {
    if (currentProxyPort)
      return currentProxyPort;
    currentProxyPort = await startProxy(() => tokenStore.getValidAccessToken(), logger);
    return currentProxyPort;
  };
  const providerDisposable = providers.register({
    id: "cursor",
    name: "Cursor",
    description: "Access Claude, GPT, Gemini and other models via your Cursor subscription",
    authType: "oauth",
    sdkType: "openai-compatible",
    async initialize() {
      logger.info("Cursor provider initialized");
    },
    async isAuthenticated() {
      return tokenStore.hasValidToken();
    },
    async authenticate() {
      try {
        const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
        ui.showNotification("Opening browser for Cursor login...", { type: "info" });
        logger.info("Starting Cursor OAuth flow...");
        if (!await ui.openExternal(loginUrl))
          openBrowser(loginUrl);
        ui.showNotification("Waiting for Cursor login to complete...", { type: "info" });
        const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
        await tokenStore.saveTokens({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: getTokenExpiry(accessToken)
        });
        ui.showNotification("Successfully connected to Cursor!", { type: "success" });
        logger.info("Cursor authentication successful");
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Authentication failed";
        logger.error("Cursor authentication error:", error);
        ui.showError(`Authentication failed: ${message}`);
        return { success: false, error: message };
      }
    },
    async logout() {
      await tokenStore.clearTokens();
      ui.showNotification("Logged out from Cursor", { type: "info" });
      logger.info("Cursor logout successful");
    },
    async getModels() {
      await catalogHydration;
      const tokens = tokenStore.getTokens();
      const models = tokens ? await getCursorModels(tokens.access_token).catch(() => getFallbackModels()) : getFallbackModels();
      return toProviderModels(models);
    },
    async fetchModels() {
      logger.info("Fetching available models from Cursor API...");
      try {
        await catalogHydration;
        const accessToken = await tokenStore.getValidAccessToken();
        const models = await getCursorModels(accessToken);
        const collapsed = toProviderModels(models);
        logger.info(`Fetched ${models.length} models from Cursor API (collapsed to ${collapsed.length} picker entries)`);
        return collapsed;
      } catch (error) {
        logger.error("Error fetching models:", error);
        return this.getModels();
      }
    },
    async getSDKConfig() {
      await catalogHydration;
      const port = await ensureProxy();
      return {
        apiKey: DUMMY_API_KEY,
        baseURL: `http://localhost:${port}/v1`,
        fetch: createProxyFetch()
      };
    }
  });
  const loginCommand = commands.register("login", async () => {
    ui.showNotification("Use the provider settings to connect to Cursor", { type: "info" });
  });
  const logoutCommand = commands.register("logout", async () => {
    await tokenStore.clearTokens();
    ui.showNotification("Logged out from Cursor", { type: "info" });
  });
  const statusCommand = commands.register("status", async () => {
    const isAuth = tokenStore.hasValidToken();
    if (isAuth) {
      ui.showNotification("Connected to Cursor", { type: "success" });
    } else {
      ui.showNotification("Not connected to Cursor", { type: "warning" });
    }
  });
  logger.info("Cursor Auth plugin activated");
  return {
    dispose: () => {
      stopProxy();
      providerDisposable.dispose();
      loginCommand.dispose();
      logoutCommand.dispose();
      statusCommand.dispose();
      logger.info("Cursor Auth plugin deactivated");
    }
  };
}
function openBrowser(url) {
  const { exec } = __require("node:child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}
export {
  activate
};
