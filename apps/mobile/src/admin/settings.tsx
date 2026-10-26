import type { CatalogModel } from "@mate/admin";
import type { AgentSettingsInput } from "./client";
import { Field, Select } from "./ui";

export type SettingsDraft = { model: string; thinking: string; instructions: string };
export const emptySettings: SettingsDraft = { model: "", thinking: "", instructions: "" };
export function settingsDraft(settings: AgentSettingsInput): SettingsDraft {
  return {
    model: `${settings.model.provider}/${settings.model.modelId}`,
    thinking: settings.thinkingLevel ?? "",
    instructions: settings.instructions ?? "",
  };
}
export function settingsBody(
  value: SettingsDraft,
  models: readonly CatalogModel[],
): AgentSettingsInput {
  const model = models.find((model) => `${model.provider}/${model.modelId}` === value.model);
  if (!model) throw "请选择一个模型。";
  return {
    model: { provider: model.provider, modelId: model.modelId },
    ...(value.thinking ? { thinkingLevel: value.thinking } : {}),
    ...(value.instructions.trim() ? { instructions: value.instructions } : {}),
  };
}
export function SettingsFields({
  models,
  value,
  onChange,
  disabled,
}: {
  models: readonly CatalogModel[];
  value: SettingsDraft;
  onChange: (value: SettingsDraft) => void;
  disabled: boolean;
}) {
  const selected = models.find((model) => `${model.provider}/${model.modelId}` === value.model);
  return (
    <>
      <Select
        label="模型"
        disabled={disabled}
        value={value.model}
        options={models.map((model) => ({
          value: `${model.provider}/${model.modelId}`,
          label: `${model.provider} · ${model.name}`,
        }))}
        onChange={(model) => onChange({ ...value, model, thinking: "" })}
      />
      <Select
        label="思考级别"
        disabled={disabled}
        value={value.thinking}
        options={[
          { value: "", label: "默认" },
          ...(selected?.thinkingLevels ?? []).map((value) => ({ value, label: value })),
        ]}
        onChange={(thinking) => onChange({ ...value, thinking })}
      />
      <Field
        label="说明文字（可选）"
        value={value.instructions}
        multiline
        maxLength={50_000}
        editable={!disabled}
        onChangeText={(instructions) => onChange({ ...value, instructions })}
      />
    </>
  );
}
