/** Default Qwen endpoint + model for the auditor agent; QWEN_BASE_URL / QWEN_MODEL override them. */
export const QWEN_DEFAULTS = {
  baseUrl: "https://maas.qwencloudapi.com/compatible-mode/v1",
  model: "qwen3.8-max",
};

/** "qwen-plus-character" → "Qwen Plus Character", "qwen3.8-max" → "Qwen 3.8 Max". */
export function modelLabel(id: string) {
  return id
    .split("-")
    .map((part) => part.replace(/^qwen(?=\d)/i, "qwen ").replace(/\b[a-z]/g, (c) => c.toUpperCase()))
    .join(" ");
}
