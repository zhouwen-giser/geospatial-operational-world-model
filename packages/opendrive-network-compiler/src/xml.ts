export interface XmlElement { name: string; attributes: Record<string, string>; children: XmlElement[]; }

function fail(message: string, offset: number): never { throw new Error(`INVALID_XML at byte ${offset}: ${message}`); }
function isSpace(c: string): boolean { return c === " " || c === "\n" || c === "\r" || c === "\t"; }
function isNameStart(c: string): boolean { const n = c.charCodeAt(0); return c === "_" || c === ":" || (n >= 65 && n <= 90) || (n >= 97 && n <= 122); }
function isNameChar(c: string): boolean { const n = c.charCodeAt(0); return isNameStart(c) || c === "-" || c === "." || (n >= 48 && n <= 57); }

function decodeEntities(value: string, offset: number): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "&") { out += value[i]; continue; }
    const end = value.indexOf(";", i + 1); if (end < 0) fail("unterminated entity", offset + i);
    const entity = value.slice(i + 1, end);
    if (entity === "amp") out += "&"; else if (entity === "lt") out += "<"; else if (entity === "gt") out += ">";
    else if (entity === "quot") out += '"'; else if (entity === "apos") out += "'";
    else if (entity.startsWith("#x")) out += String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    else if (entity.startsWith("#")) out += String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    else fail(`entity ${entity} is not permitted`, offset + i);
    i = end;
  }
  return out;
}

/** Strict non-validating parser for the element/attribute-only OpenDRIVE subset. DTDs and entities are fail-closed. */
export function parseXml(xml: string): XmlElement {
  const upper = xml.toUpperCase();
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) fail("DTD and entity declarations are forbidden", 0);
  const stack: XmlElement[] = []; let root: XmlElement | undefined; let i = 0;
  const skipSpace = () => { while (i < xml.length && isSpace(xml[i]!)) i += 1; };
  const name = () => { if (!isNameStart(xml[i] ?? "")) fail("expected XML name", i); const start = i++; while (i < xml.length && isNameChar(xml[i]!)) i++; return xml.slice(start, i); };
  while (i < xml.length) {
    if (xml[i] !== "<") { const start = i; while (i < xml.length && xml[i] !== "<") i++; if (xml.slice(start, i).trim() !== "") fail("text nodes are unsupported", start); continue; }
    if (xml.startsWith("<!--", i)) { const end = xml.indexOf("-->", i + 4); if (end < 0) fail("unterminated comment", i); i = end + 3; continue; }
    if (xml.startsWith("<?", i)) { const end = xml.indexOf("?>", i + 2); if (end < 0) fail("unterminated processing instruction", i); i = end + 2; continue; }
    if (xml.startsWith("<![CDATA[", i)) fail("CDATA is unsupported", i);
    if (xml.startsWith("<!", i)) fail("declarations are forbidden", i);
    i += 1;
    if (xml[i] === "/") { i++; const closing = name(); skipSpace(); if (xml[i] !== ">") fail("expected >", i); i++; const opened = stack.pop(); if (!opened || opened.name !== closing) fail(`mismatched closing tag ${closing}`, i); continue; }
    const element: XmlElement = { name: name(), attributes: {}, children: [] }; skipSpace();
    while (i < xml.length && xml[i] !== ">" && !(xml[i] === "/" && xml[i + 1] === ">")) {
      const attribute = name(); if (Object.hasOwn(element.attributes, attribute)) fail(`duplicate attribute ${attribute}`, i); skipSpace();
      if (xml[i] !== "=") fail("expected =", i); i++; skipSpace(); const quote = xml[i]; if (quote !== '"' && quote !== "'") fail("attribute must be quoted", i); i++;
      const start = i; while (i < xml.length && xml[i] !== quote) i++; if (i >= xml.length) fail("unterminated attribute", start);
      element.attributes[attribute] = decodeEntities(xml.slice(start, i), start); i++; skipSpace();
    }
    const selfClosing = xml[i] === "/"; i += selfClosing ? 2 : 1;
    const parent = stack.at(-1); if (parent) parent.children.push(element); else { if (root) fail("multiple root elements", i); root = element; }
    if (!selfClosing) stack.push(element);
  }
  if (stack.length) fail(`unclosed element ${stack.at(-1)!.name}`, xml.length);
  if (!root) fail("missing root element", 0);
  return root;
}

export function children(element: XmlElement, name: string): XmlElement[] { return element.children.filter((child) => child.name === name); }
export function child(element: XmlElement, name: string): XmlElement | undefined { return element.children.find((item) => item.name === name); }
export function requiredChild(element: XmlElement, name: string): XmlElement { const value = child(element, name); if (!value) throw new Error(`INVALID_OPENDRIVE: ${element.name} is missing ${name}`); return value; }
export function requiredAttribute(element: XmlElement, name: string): string { const value = element.attributes[name]; if (value === undefined) throw new Error(`INVALID_OPENDRIVE: ${element.name} is missing @${name}`); return value; }
export function numberAttribute(element: XmlElement, name: string): number { const text = requiredAttribute(element, name); const value = Number(text); if (!Number.isFinite(value)) throw new Error(`INVALID_OPENDRIVE: ${element.name}/@${name} is not finite`); return value; }
