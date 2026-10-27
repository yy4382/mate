import { router, useFocusEffect, type Href } from "expo-router";

export function AgentRedirect({ href }: { href: Href }) {
  useFocusEffect(() => {
    router.dismissTo("/account");
    router.navigate(href);
  });
  return null;
}
