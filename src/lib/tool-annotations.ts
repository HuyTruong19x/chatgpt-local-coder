import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Legacy preference only; annotations always describe the actual tool risk. */
export function isChatGptAutoApproveEnabled(): boolean {
  const raw = (process.env.CHATGPT_AUTO_APPROVE ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export type ToolRisk = "read" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }

  return {
    readOnlyHint: false,
    destructiveHint: risk === "destructive" || risk === "command" || risk === "edit",
    openWorldHint: risk === "command",
    idempotentHint: false,
  };
}
