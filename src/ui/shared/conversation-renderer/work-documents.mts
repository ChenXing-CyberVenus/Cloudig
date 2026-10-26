import type { JsonObject } from "../../../core/contracts/types.mts";
import { isJsonObject } from "../../../core/contracts/types.mts";
import type { InteractiveFormat } from "./interactive-protocol.mts";

export type WorkDocument = Readonly<{ path: string; title: string; format: InteractiveFormat }>;
/** Source metadata points only at files declared by this one saved work. */
export function workDocuments(data: JsonObject | undefined, paths: readonly string[], english: boolean): WorkDocument[] {
  if (!data) return [];
  const result: WorkDocument[] = [], research = isJsonObject(data["research"]) ? data["research"] : {};
  const add = (path: unknown, title: unknown) => {
    if(typeof path!=="string"||!paths.includes(path)||result.some(item=>item.path===path))return;
    const format:InteractiveFormat|undefined=/\.(?:html?|svg)$/iu.test(path)?"html":/\.(?:md|markdown|xml|txt)$/iu.test(path)?"document":/\.(?:jsx|tsx)$/iu.test(path)?"react":undefined;
    if(format)result.push({path,title:typeof title==="string"?title.replace(/<[^>]*>/gu,""):path,format});
  };
  for(const visual of Array.isArray(research["visuals"])?research["visuals"]:[])if(isJsonObject(visual))add(visual["path"],visual["title"]);
  for(const [index,revision] of (Array.isArray(data["revisions"])?data["revisions"]:[]).entries())if(isJsonObject(revision))add(revision["path"],`${english?"Saved revision":"保存记录"} ${index+1}`);
  return result;
}
