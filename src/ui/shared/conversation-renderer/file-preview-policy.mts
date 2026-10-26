import type { InteractiveFile, InteractivePackage } from "./interactive-protocol.mts";

export function previewKind(name: string, mime = ""): string | undefined {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (mime.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "flac", "aac"].includes(extension)) return "audio";
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (["pptx", "xlsx", "docx", "pdf", "glb", "md", "txt", "csv", "json", "xml", "html", "htm", "js", "ts", "py", "css", "log", "svg", "png", "jpg", "jpeg", "webp", "gif"].includes(extension)) return extension;
  if (mime === "model/gltf-binary") return "glb";
  const media:Record<string,string>={"application/pdf":"pdf","application/vnd.openxmlformats-officedocument.presentationml.presentation":"pptx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"xlsx","application/vnd.openxmlformats-officedocument.wordprocessingml.document":"docx","image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/svg+xml":"svg","image/gif":"gif"};
  if (media[mime]) return media[mime];
  if (mime.split(";", 1)[0]?.trim().toLowerCase() === "text/html") return "html";
  if (mime.startsWith("text/")) return "txt";
  return;
}

/** No stored Schema change: a reading target is selected from owned bytes. */
export function previewTarget(input: InteractivePackage): InteractiveFile | undefined {
  if (input.preview) return input.files.find(f => f.path === input.entry);
  if (input.source === "chat.mistral.ai_slides" && input.format === "slides" && input.data?.["presentation"]) return;
  const extension = input.source === "chat.mistral.ai_slides" ? ".pptx" : input.source === "chat.mistral.ai_spreadsheet" ? ".xlsx" : undefined;
  const choices = extension ? input.files.filter(f => f.path.toLowerCase().endsWith(extension)) : [];
  return choices.length === 1 ? choices[0] : undefined;
}
export const isOfficePreview = (file: InteractiveFile | undefined): boolean => !!file && ["pptx", "xlsx", "docx", "pdf"].includes(previewKind(file.path, file.mime) ?? "");
export const isBinaryPreview = (file: InteractiveFile | undefined): boolean => isOfficePreview(file) || !!file && previewKind(file.path, file.mime) === "glb";
export const isMediaPreview = (file: InteractiveFile | undefined): boolean => !!file && ["audio", "video"].includes(previewKind(file.path, file.mime) ?? "");
