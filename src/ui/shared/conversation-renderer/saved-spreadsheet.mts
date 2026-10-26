import { INTERACTIVE_LIMITS } from "./interactive-protocol.mts";
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const elements = (node: Document | Element, name: string) => [...node.getElementsByTagNameNS("*", name)];
function column(address: string): number | undefined {
  const letters = /^([A-Z]+)[1-9][0-9]*$/u.exec(address)?.[1]; if (!letters) return;
  let value = 0; for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Number.isSafeInteger(value) ? value : undefined;
}

/** A read view over the saved package XML. Order/identity come from workbook
 * relationships, never ZIP order or guessed sheet numbers. Cached formula
 * values are shown as captured; no spreadsheet calculation engine is claimed. */
export function savedSpreadsheet(raw: string, document: Document): string {
  const parts = object(object(JSON.parse(raw))["source_parts"]), parser = new document.defaultView!.DOMParser();
  const xml = (path: string): Document => {
    if (typeof parts[path] !== "string") throw new TypeError(`Saved spreadsheet part is missing: ${path}`);
    const result = parser.parseFromString(parts[path] as string, "application/xml");
    if (result.getElementsByTagName("parsererror").length) throw new TypeError(`Saved spreadsheet XML is invalid: ${path}`);
    return result;
  };
  const strings = typeof parts["xl/sharedStrings.xml"] === "string" ? elements(xml("xl/sharedStrings.xml"), "si").map(si => elements(si, "t").map(t => t.textContent ?? "").join("")) : [];
  const relationships = new Map(elements(xml("xl/_rels/workbook.xml.rels"), "Relationship").map(n => [n.getAttribute("Id"), n]));
  const styles=typeof parts["xl/styles.xml"]==="string"?xml("xl/styles.xml"):undefined;
  const group=(name:string)=>styles?[...(elements(styles,name)[0]?.children??[])]:[];
  const fonts=group("fonts"),fills=group("fills"),formats=group("cellXfs");
  const hex=(e:Element|undefined)=>{const value=e?.getAttribute("rgb");return value&&/^[\da-f]{6}(?:[\da-f]{2})?$/iu.test(value)?`#${value.slice(-6)}`:undefined;};
  const styleFor=(cell:Element)=>{
    const format=formats[Number(cell.getAttribute("s")??0)],font=fonts[Number(format?.getAttribute("fontId")??0)],fill=fills[Number(format?.getAttribute("fillId")??0)];
    const alignment=format&&elements(format,"alignment")[0],rules=["padding:2px 4px","font-size:11pt","line-height:1.2","color:#303030","background:#fff","border:1px solid #d6d6d6","overflow:hidden","text-overflow:clip"];
    if(font){const size=Number(elements(font,"sz")[0]?.getAttribute("val"));if(size>0&&size<512)rules.push(`font-size:${size}pt`);
      if(elements(font,"b").length)rules.push("font-weight:700");if(elements(font,"i").length)rules.push("font-style:italic");
      const ink=hex(elements(font,"color")[0]);if(ink)rules.push(`color:${ink}`);
    }
    const paint=fill&&hex(elements(fill,"fgColor")[0]);if(paint)rules.push(`background:${paint}`);
    const horizontal=alignment?.getAttribute("horizontal"),vertical=alignment?.getAttribute("vertical");
    if(horizontal&&["left","center","right","justify"].includes(horizontal))rules.push(`text-align:${horizontal}`);
    if(vertical&&["top","center","bottom"].includes(vertical))rules.push(`vertical-align:${vertical==="center"?"middle":vertical}`);
    rules.push(alignment?.getAttribute("wrapText")==="1"?"white-space:pre-wrap":"white-space:pre");
    return rules.join(";");
  };
  const sheets = elements(xml("xl/workbook.xml"), "sheet");
  const resolve = (sheet: Element): string => {
    const id = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? sheet.getAttributeNS("http://purl.oclc.org/ooxml/officeDocument/relationships", "id");
    const relation = relationships.get(id), target = relation?.getAttribute("Target");
    if (!target || relation?.getAttribute("TargetMode") === "External" || !/\/worksheet$/u.test(relation?.getAttribute("Type") ?? "")) throw new TypeError("Saved spreadsheet has an unresolved worksheet relationship");
    const url = new URL(target, "https://package.invalid/xl/workbook.xml");
    if (url.origin !== "https://package.invalid" || url.search || url.hash) throw new TypeError("Saved worksheet points outside its package");
    return decodeURIComponent(url.pathname.slice(1));
  };
  return sheets.map((sheet, i) => {
    const path = resolve(sheet), worksheet = xml(path), data = elements(worksheet, "sheetData")[0];
    const savedRows=data ? elements(data,"row"):[], byRow=new Map(savedRows.map(row=>[Number(row.getAttribute("r")),row]));
    const lastRow=Math.max(0,...byRow.keys());if(lastRow>INTERACTIVE_LIMITS.sheetRows)throw new RangeError("Saved spreadsheet row count exceeds the preview budget");
    const rows=Array.from({length:lastRow},(_,i)=>{const existing=byRow.get(i+1);if(existing)return existing;const row=worksheet.createElementNS(worksheet.documentElement.namespaceURI,"row");row.setAttribute("r",String(i+1));return row;});
    const merges=elements(worksheet,"mergeCell").map(node=>{
      const [start,end]=String(node.getAttribute("ref")).split(":"),left=column(start??""),right=column(end??start??"");
      const top=Number(start?.match(/\d+$/u)?.[0]),bottom=Number((end??start)?.match(/\d+$/u)?.[0]);
      if(!left||!right||right<left||!Number.isSafeInteger(top)||!Number.isSafeInteger(bottom)||top<1||bottom<top)throw new TypeError("Saved spreadsheet merge range is invalid");
      return{left,right,top,bottom};
    });
    const width=merges.reduce((max,m)=>Math.max(max,m.right),elements(worksheet,"c").reduce((max,c)=>Math.max(max,column(c.getAttribute("r")??"")??0),0));
    if(width>INTERACTIVE_LIMITS.sheetColumns||rows.length>INTERACTIVE_LIMITS.sheetRows)throw new RangeError("Saved spreadsheet dimensions exceed the preview budget");
    const columns=elements(worksheet,"col"),defaultWidth=Number(elements(worksheet,"sheetFormatPr")[0]?.getAttribute("defaultColWidth")??8.43);
    const columnWidths=Array.from({length:width},(_,i)=>{const col=columns.find(c=>i+1>=Number(c.getAttribute("min"))&&i+1<=Number(c.getAttribute("max")));return Math.max(0,Math.min(INTERACTIVE_LIMITS.sheetColumnPixels,Number(col?.getAttribute("width")??defaultWidth)*7+5));});
    const totalWidth=columnWidths.reduce((a,b)=>a+b,40);
    const body = rows.map(row => {
      const rowNumber=Number(row.getAttribute("r")),covered=merges.filter(m=>rowNumber>=m.top&&rowNumber<=m.bottom);
      const cells = elements(row, "c").map(c => ({ c, col: column(c.getAttribute("r") ?? "") })).sort((a, b) => (a.col ?? 0) - (b.col ?? 0));
      let previous = 0;
      const gap=(from:number,to:number)=>{
        let text="",cursor=from;
        for(const merged of covered.filter(m=>m.top<rowNumber&&m.right>=from&&m.left<=to).sort((a,b)=>a.left-b.left)){
          if(merged.left>cursor)text+=`<td colspan="${merged.left-cursor}" class="sheet-gap"></td>`;
          cursor=Math.max(cursor,merged.right+1);
        }
        return text+(cursor<=to?`<td colspan="${to-cursor+1}" class="sheet-gap"></td>`:"");
      };
      const height=Number(row.getAttribute("ht")??15);
      return `<tr style="height:${Number.isFinite(height)&&height>0?height:15}pt"><th scope="row">${height<10?"":esc(row.getAttribute("r") ?? "")}</th>${cells.map(({ c, col }) => {
        const merged=covered.find(m=>col!==undefined&&col>=m.left&&col<=m.right);
        if(merged&&(rowNumber!==merged.top||col!==merged.left))return "";
        if (col === undefined || col <= previous) throw new TypeError("Saved spreadsheet cell position is missing or duplicated");
        const blank = gap(previous+1,col-1); previous = merged?.right??col;
        const v = elements(c, "v")[0]?.textContent ?? "", inline = elements(c, "is")[0], formula = elements(c, "f")[0]?.textContent;
        const value = c.getAttribute("t") === "s" ? strings[Number(v)] ?? v : c.getAttribute("t") === "inlineStr" && inline ? elements(inline, "t").map(t => t.textContent ?? "").join("") : v || (formula ? `=${formula}` : "");
        const span=merged?` colspan="${merged.right-merged.left+1}" rowspan="${rows.filter(r=>Number(r.getAttribute("r"))>=merged.top&&Number(r.getAttribute("r"))<=merged.bottom).length}"`:"";
        return `${blank}<td style="${styleFor(c)}${height<10&&!value?';padding:0;line-height:0;font-size:0':''}" data-cell="${esc(c.getAttribute("r"))}"${span} title="${esc(formula?`=${formula}`:value)}">${esc(value)}</td>`;
      }).join("")}${gap(previous+1,width)}</tr>`;
    }).join("");
    return `<details class="saved-sheet"${i === 0 ? " open" : ""}><summary>${esc(sheet.getAttribute("name") ?? path)}</summary><div data-scroll-region class="saved-sheet-scroll"><table style="--sheet-columns:${width};width:${totalWidth}px;table-layout:fixed;background:#fff;color:#303030"><colgroup><col class="sheet-row-number" style="width:40px">${columnWidths.map(w=>`<col style="width:${w}px">`).join("")}</colgroup><tbody>${body}</tbody></table></div></details>`;
  }).join("");
}
