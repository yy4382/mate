import { t, thinkingText } from "../i18n";
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
  if (!model) throw t("management.select_a_model");
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
        title={t("management.runtime_configuration")}
        footer={node ? t("management.the_home_node_runs_commands_by_default") : ""}
      >
        {node}
        <Select
          label={t("management.models")}
          disabled={disabled}
          value={value.model}
          options={models.map((model) => ({
            value: `${model.provider}/${model.modelId}`,
            label: `${model.name} · ${model.provider}\n${model.modelId}`,
          }))}
          onChange={(model) => onChange({ ...value, model, thinking: "" })}
        />
        <Select
          label={t("management.thinking_level")}
          disabled={disabled || !selected}
          value={value.thinking}
          options={[
            { value: "", label: t("management.default") },
            ...(selected?.thinkingLevels ?? []).map((value) => ({
              value,
              label: thinkingText(value),
            })),
          ]}
          onChange={(thinking) => onChange({ ...value, thinking })}
        />
      </Section>
      <Section footer={t("management.the_model_and_instructions_can_be_changed")}>
        <Row
          title={t("management.instructions")}
          value={value.instructions.trim() ? t("management.filled_in") : t("management.optional")}
          subtitle={
            value.instructions.trim() ? (value.instructions.split("\n")[0] ?? "").slice(0, 90) : ""
          }
          disabled={disabled}
          onPress={() => setInstructionsOpen(true)}
        />
      </Section>
      <Sheet
        visible={instructionsOpen}
        title={t("management.instructions")}
        onClose={() => setInstructionsOpen(false)}
      >
        <Field
          label={t("management.instructions_for_the_agent")}
          testID="agent-instructions"
          value={value.instructions}
          multiline
          maxLength={50_000}
          editable={!disabled}
          onChangeText={(instructions) => onChange({ ...value, instructions })}
        />
        <Caption>{t("management.instructions_are_saved_with_the_model_settings")}</Caption>
        <Button title={t("observation.done")} onPress={() => setInstructionsOpen(false)} />
      </Sheet>
    </>
  );
}
