import { t, listText } from "./i18n";
import { Linking, Text, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import type { AccountView } from "@mate/chat/contracts";
import { useTheme } from "./theme";

export function MessageBody({
  text,
  accounts,
  mentions = [],
}: {
  text: string;
  accounts: readonly AccountView[];
  mentions?: readonly number[];
}) {
  const c = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <EnrichedMarkdownText
        markdown={text}
        flavor="github"
        selectable
        allowFontScaling
        maxFontSizeMultiplier={0}
        enableTaskListItemToggle={false}
        md4cFlags={{ latexMath: false, hardSoftBreaks: true }}
        onLinkPress={({ url }) => {
          if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
        }}
        markdownStyle={{
          paragraph: {
            fontSize: 17,
            lineHeight: 26,
            color: c.foreground,
            marginTop: 0,
            marginBottom: 8,
          },
          h1: { fontSize: 26, color: c.foreground },
          h2: { fontSize: 24, color: c.foreground },
          h3: { fontSize: 22, color: c.foreground },
          h4: { fontSize: 20, color: c.foreground },
          h5: { fontSize: 18, color: c.foreground },
          h6: { fontSize: 17, color: c.foreground },
          list: { fontSize: 17, color: c.foreground },
          blockquote: { fontSize: 17, color: c.muted, borderColor: c.border },
          code: {
            fontFamily: "Menlo",
            fontSize: 15,
            color: c.foreground,
            backgroundColor: c.subtle,
          },
          codeBlock: {
            fontFamily: "Menlo",
            fontSize: 15,
            color: c.foreground,
            backgroundColor: c.subtle,
            borderColor: c.border,
            borderRadius: 6,
          },
          link: { color: c.accent, underline: true },
          table: {
            fontSize: 16,
            color: c.foreground,
            borderColor: c.border,
            headerBackgroundColor: c.subtle,
            rowEvenBackgroundColor: c.background,
            rowOddBackgroundColor: c.subtle,
          },
        }}
        selectionMenuConfig={{
          copy: { label: t("chat.copy") },
          copyAsMarkdown: { label: t("chat.copy_markdown") },
        }}
        accessibilityLabels={{
          list: {
            bulletPoint: t("chat.list_item"),
            nestedBulletPoint: t("chat.nested_list_item"),
            orderedItem: t("chat.item_n"),
            nestedOrderedItem: t("chat.nested_item_n"),
          },
          blockquote: { quote: t("chat.quote"), nestedQuote: t("chat.nested_quote") },
          table: { row: t("chat.row_n_content") },
          rotor: { headings: t("chat.headings"), links: t("chat.links"), images: t("chat.images") },
        }}
      />
      {mentions.length > 0 && (
        <Text style={{ color: c.accent, fontSize: 15 }}>
          {t("chat.mentions_list", {
            names: listText(
              mentions.map((id) => `@${accounts.find((a) => a.accountId === id)?.handle ?? id}`),
            ),
          })}
        </Text>
      )}
    </View>
  );
}
