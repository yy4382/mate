import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { t } from "../i18n.ts";
import { useAccounts, type AccountView } from "./accounts.ts";
import { AccountAvatar } from "./AccountAvatar.tsx";
import { put } from "./api.ts";
import { refusalText } from "./humans.ts";
import { Button, Card, CardBody, ErrorLine } from "./ui.tsx";

async function avatarPng(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error(t("AvatarEditor.chooseImage"));
  if (file.size > 5 * 1024 * 1024) throw new Error(t("AvatarEditor.tooLarge"));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(t("AvatarEditor.unreadable"));
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(side, 256);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error(t("AvatarEditor.cannotProcess"));
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  } finally {
    bitmap.close();
  }
}

export function AvatarEditor({
  accountId,
  name,
  endpoint,
}: {
  accountId: number;
  name: string;
  endpoint: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const account = useAccounts().data?.find((item) => item.accountId === accountId);
  const upload = useMutation({
    mutationFn: async (file: File | null) => {
      const png = file === null ? null : await avatarPng(file);
      return put<AccountView>(endpoint, { requestId: crypto.randomUUID(), png });
    },
    onSettled: () => {
      if (input.current !== null) input.current.value = "";
    },
  });
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center gap-4">
          <AccountAvatar accountId={accountId} name={name} size="lg" />
          <div className="grid flex-1 gap-2">
            <div className="flex flex-wrap gap-2">
              <input
                ref={input}
                type="file"
                aria-label={t("AvatarEditor.imageLabel")}
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                tabIndex={-1}
                disabled={upload.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) upload.mutate(file);
                }}
              />
              <Button disabled={upload.isPending} onClick={() => input.current?.click()}>
                {upload.isPending ? t("AvatarEditor.uploading") : t("AvatarEditor.upload")}
              </Button>
              {account?.avatarVersion == null ? null : (
                <Button disabled={upload.isPending} onClick={() => upload.mutate(null)}>
                  {t("AvatarEditor.restoreDefault")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">{t("AvatarEditor.hint")}</p>
            {upload.isSuccess ? (
              <p role="status" className="text-sm text-muted">
                {t("AvatarEditor.saved")}
              </p>
            ) : null}
            <ErrorLine error={upload.isError ? refusalText(upload.error) : null} />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
