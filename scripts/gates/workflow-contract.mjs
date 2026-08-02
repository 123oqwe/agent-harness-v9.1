import { createHash } from "node:crypto";

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

const indentation = (line) => line.match(/^ */u)[0].length;
const scalar = (text) => {
  if (text.includes(" #") || /^(?:&|\*|!|<<:)/u.test(text)) throw new Error("workflow uses a forbidden YAML feature");
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))
    return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^(?:0|[1-9][0-9]*)$/u.test(text)) return Number(text);
  return text;
};

export const parseRestrictedWorkflowYaml = (source) => {
  if (typeof source !== "string" || source.includes("\t") || source.includes("\0"))
    throw new Error("workflow must be UTF-8 text using spaces only");
  const raw = source.replaceAll("\r\n", "\n").split("\n");
  let cursor = 0;
  const ignorable = (line) => line.trim() === "" || line.trimStart().startsWith("#");
  const skip = () => { while (cursor < raw.length && ignorable(raw[cursor])) cursor += 1; };
  const keyValue = (text) => {
    const match = /^([^:#][^:]*):(?:\s*(.*))?$/u.exec(text);
    if (!match) throw new Error(`unsupported workflow YAML at line ${cursor + 1}`);
    return [match[1].trim(), match[2] ?? ""];
  };
  const assign = (object, key, value) => {
    if (Object.hasOwn(object, key)) throw new Error(`duplicate workflow key: ${key}`);
    object[key] = value;
  };
  const parseValue = (parentIndent, text) => {
    if (text === "|") {
      cursor += 1;
      const start = cursor;
      let blockIndent = null;
      while (cursor < raw.length && (raw[cursor].trim() === "" || indentation(raw[cursor]) > parentIndent)) {
        if (raw[cursor].trim() !== "" && blockIndent === null) blockIndent = indentation(raw[cursor]);
        cursor += 1;
      }
      if (blockIndent === null) throw new Error("workflow block scalar is empty");
      return raw.slice(start, cursor).map((line) => line.trim() === "" ? "" : line.slice(blockIndent)).join("\n").replace(/\n+$/u, "");
    }
    if (text !== "") { cursor += 1; return scalar(text); }
    cursor += 1;
    skip();
    if (cursor >= raw.length || indentation(raw[cursor]) <= parentIndent) return null;
    return parseBlock(indentation(raw[cursor]));
  };
  const parseMapping = (indent, initial = null) => {
    const object = {};
    if (initial !== null) {
      const [key, text] = keyValue(initial);
      assign(object, key, parseValue(indent, text));
    }
    while (true) {
      skip();
      if (cursor >= raw.length || indentation(raw[cursor]) !== indent || raw[cursor].slice(indent).startsWith("- ")) break;
      const [key, text] = keyValue(raw[cursor].slice(indent));
      assign(object, key, parseValue(indent, text));
    }
    return object;
  };
  const parseBlock = (indent) => {
    skip();
    if (raw[cursor].slice(indent).startsWith("- ")) {
      const array = [];
      while (true) {
        skip();
        if (cursor >= raw.length || indentation(raw[cursor]) !== indent || !raw[cursor].slice(indent).startsWith("- ")) break;
        const initial = raw[cursor].slice(indent + 2);
        if (initial === "" || initial.startsWith("-") || !initial.includes(":")) throw new Error("workflow sequence items must be mappings");
        array.push(parseMapping(indent + 2, initial));
      }
      return array;
    }
    return parseMapping(indent);
  };
  skip();
  if (cursor >= raw.length || indentation(raw[cursor]) !== 0) throw new Error("workflow root mapping is missing");
  const result = parseBlock(0);
  skip();
  if (cursor !== raw.length) throw new Error(`unparsed workflow YAML at line ${cursor + 1}`);
  return result;
};

export const workflowAstSha256 = (source) => createHash("sha256")
  .update(canonicalJson(parseRestrictedWorkflowYaml(source))).digest("hex");
