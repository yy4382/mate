export interface PromptSource {
  id: string;
  source: string;
  condition: string;
  role: "system" | "user";
}
export interface PromptSection extends PromptSource {
  text: string;
}
