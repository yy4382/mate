import type { CatalogModel } from "@mate/admin";
import { useState, type ReactNode } from "react";
import type { AgentSettingsInput } from "./client";
import { Button, Caption, Field, Row, Section, Select, Sheet } from "../ui";

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
  node,
}: {
  models: readonly CatalogModel[];
  value: SettingsDraft;
  onChange(value: SettingsDraft): void;
  disabled: boolean;
  node?: ReactNode;
}) {
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const selected = models.find((model) => `${model.provider}/${model.modelId}` === value.model);
  return (
    <>
      <Section
        title="运行配置"
        footer={node ? "主 Node 执行默认命令并保存主工作区，创建后不能更换。" : ""}
      >
        {node}
        <Select
          label="模型"
          disabled={disabled}
          value={value.model}
          options={models.map((model) => ({
            value: `${model.provider}/${model.modelId}`,
            label: `${model.name} · ${model.provider}\n${model.modelId}`,
          }))}
          onChange={(model) => onChange({ ...value, model, thinking: "" })}
        />
        <Select
          label="思考级别"
          disabled={disabled || !selected}
          value={value.thinking}
          options={[
            { value: "", label: "默认" },
            ...(selected?.thinkingLevels ?? []).map((value) => ({ value, label: value })),
          ]}
          onChange={(thinking) => onChange({ ...value, thinking })}
        />
      </Section>
      <Section footer="模型和说明文字可以稍后修改，从下一次模型请求起生效。">
        <Row
          title="说明文字"
          value={value.instructions.trim() ? "已填写" : "可选"}
          subtitle={
            value.instructions.trim() ? (value.instructions.split("\n")[0] ?? "").slice(0, 90) : ""
          }
          disabled={disabled}
          onPress={() => setInstructionsOpen(true)}
        />
      </Section>
      <Sheet visible={instructionsOpen} title="说明文字" onClose={() => setInstructionsOpen(false)}>
        <Field
          label="给 Agent 的说明"
          testID="agent-instructions"
          value={value.instructions}
          multiline
          maxLength={50_000}
          editable={!disabled}
          onChangeText={(instructions) => onChange({ ...value, instructions })}
        />
        <Caption>说明会随模型设置一起保存。返回不会提交更改。</Caption>
        <Button title="完成" onPress={() => setInstructionsOpen(false)} />
      </Sheet>
    </>
  );
}
