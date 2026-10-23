import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { ChevronDown, MoreHorizontal, X } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { describe } from "./api.ts";

type Class = string | false | null | undefined;

/** Joins class names, skipping the falsy ones; a later class wins over an earlier one it conflicts with, so a caller's `className` overrides the primitive's own. */
export const cx = (...parts: Class[]): string => twMerge(parts.filter(Boolean).join(" "));

// Buttons

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm" | "icon" | "icon-sm";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-foreground text-background hover:bg-foreground/90",
  secondary: "border border-border-strong bg-background text-foreground hover:bg-subtle",
  ghost: "text-foreground hover:bg-subtle",
  danger: "bg-danger text-background hover:bg-danger/90",
};

const buttonSizes: Record<ButtonSize, string> = {
  md: "h-9 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
  icon: "size-9",
  "icon-sm": "size-8",
};

/** The look of a button, for anything that is not a `<button>` (a `Link`) but should look like one. */
export function buttonClass(
  options: {
    variant?: ButtonVariant | undefined;
    size?: ButtonSize | undefined;
    className?: string | undefined;
  } = {},
): string {
  const { variant = "secondary", size = "md", className } = options;
  return cx(
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium no-underline transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...rest} />;
}

// Form controls

const controlClass =
  "h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm font-normal text-foreground placeholder:text-muted focus-visible:border-accent focus-visible:outline-offset-0 disabled:opacity-50";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cx(controlClass, className)} {...rest} />;
}

const bareTextareaClass =
  "block w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-foreground placeholder:text-muted focus-visible:outline-none disabled:opacity-50";

/** `bare` drops the border and focus styling, for a textarea that sits inside a bordered box that owns them (the composer). */
export function Textarea({
  className,
  bare = false,
  ...rest
}: ComponentProps<"textarea"> & { bare?: boolean }) {
  return (
    <textarea
      className={cx(
        bare ? bareTextareaClass : cx(controlClass, "h-auto min-h-20 resize-y py-2 leading-6"),
        className,
      )}
      {...rest}
    />
  );
}

/** A native select, so phones show the system picker. `className` goes on the wrapper. */
export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <div className={cx("relative", className)}>
      <select className={cx(controlClass, "appearance-none pr-9")} {...rest}>
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

/** A label wrapping its control, so `getByLabel(label)` finds the control. The hint and error sit under it. */
export function Field(props: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("grid gap-1.5", props.className)}>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        {props.label}
        {props.children}
      </label>
      {props.hint === undefined ? null : <p className="text-xs text-muted">{props.hint}</p>}
      {props.error === undefined ? null : (
        <p className="text-xs text-danger" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}

// Surfaces

export function Card({ className, ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={cx("overflow-hidden rounded-lg border border-border bg-background", className)}
      {...rest}
    />
  );
}

const cardBodySizes = { compact: "p-4", form: "grid gap-4 p-5" } as const;

export function CardBody({
  size = "form",
  className,
  ...rest
}: ComponentProps<"div"> & { size?: keyof typeof cardBodySizes }) {
  return <div className={cx(cardBodySizes[size], className)} {...rest} />;
}

/** The bar under a form card: a note or a dangerous action on the left, the main button on the right. */
export function CardFooter({ className, ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-3 border-t border-border bg-subtle px-5 py-3",
        className,
      )}
      {...rest}
    />
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const badgeTones: Record<Tone | "solid" | "inverse", string> = {
  neutral: "border border-border bg-subtle text-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
  solid: "bg-accent text-background",
  inverse: "bg-foreground text-background",
};

/** `solid` is for counts that need to be noticed, such as unread mentions; `inverse` is the quiet count, such as plain unread. */
export function Badge({
  tone = "neutral",
  className,
  ...rest
}: ComponentProps<"span"> & { tone?: Tone | "solid" | "inverse" }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 text-xs font-medium",
        badgeTones[tone],
        className,
      )}
      {...rest}
    />
  );
}

const dotTones: Record<Tone, string> = {
  neutral: "bg-border-strong",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
};

export function StatusDot({ tone = "neutral", label }: { tone?: Tone; label?: string }) {
  return (
    <span
      className={cx("inline-block size-2 shrink-0 rounded-full", dotTones[tone])}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    />
  );
}

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const avatarSizes: Record<AvatarSize, string> = {
  xs: "size-5 text-xs",
  sm: "size-6 text-xs",
  md: "size-8 text-sm",
  lg: "size-10 text-base",
};

const avatarUrl = (account: number) => `https://api.dicebear.com/10.x/thumbs/svg?seed=${account}`;

/** The owner shows the name's initial. An Agent (`agentAccount` is its chat account ID) shows its generated picture, and the initial if that fails to load. */
export function Avatar({
  name,
  size = "md",
  agentAccount,
}: {
  name: string;
  size?: AvatarSize;
  agentAccount?: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = agentAccount === undefined ? undefined : avatarUrl(agentAccount);
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <span
      aria-hidden
      className={cx(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-subtle font-medium uppercase text-muted",
        avatarSizes[size],
      )}
    >
      {url === undefined || url === failedUrl ? (
        initial
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="size-full"
          onError={() => setFailedUrl(url)}
        />
      )}
    </span>
  );
}

// Dialogs

const backdropClass = "fixed inset-0 z-40 bg-backdrop";
const dialogPopupClass =
  "fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-background p-6 shadow-lg outline-none";

/** A dialog that is open while it is mounted: render it conditionally and close it from `onClose`. */
export function Dialog(props: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClass} />
        <BaseDialog.Popup className={dialogPopupClass}>
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <BaseDialog.Title className="text-base font-semibold">{props.title}</BaseDialog.Title>
              {props.description === undefined ? null : (
                <BaseDialog.Description className="text-sm text-muted">
                  {props.description}
                </BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close
              aria-label="关闭"
              className={buttonClass({
                variant: "ghost",
                size: "icon-sm",
                className: "-mr-2 -mt-1",
              })}
            >
              <X aria-hidden />
            </BaseDialog.Close>
          </div>
          <div className="mt-4">{props.children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Asks before an irreversible action. The confirm button names the action ("删除 Agent"). */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdropClass} />
        <AlertDialog.Popup className={dialogPopupClass}>
          <AlertDialog.Title className="text-base font-semibold">{props.title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-sm text-muted">
            {props.description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Close className={buttonClass({ variant: "secondary" })}>
              取消
            </AlertDialog.Close>
            <Button
              variant="danger"
              onClick={() => {
                props.onOpenChange(false);
                props.onConfirm();
              }}
            >
              {props.confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// Menu

/** A menu opened from a trigger button; the default trigger is the "更多" icon button. */
export function Menu(props: {
  /** The trigger's accessible name. */
  label?: string;
  /** The trigger's content, replacing the default icon. */
  trigger?: ReactNode;
  triggerClassName?: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        aria-label={props.label ?? "更多"}
        className={props.triggerClassName ?? buttonClass({ variant: "ghost", size: "icon-sm" })}
      >
        {props.trigger ?? <MoreHorizontal aria-hidden />}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          side={props.side ?? "bottom"}
          align={props.align ?? "end"}
          sideOffset={4}
          className="z-50"
        >
          <BaseMenu.Popup className="min-w-44 rounded-lg border border-border bg-background p-1 shadow-md outline-none">
            {props.children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

const menuItemTones = {
  default: "text-foreground",
  danger: "text-danger",
} as const;

export function MenuItem({
  icon,
  tone = "default",
  children,
  ...rest
}: {
  icon?: ReactNode;
  tone?: keyof typeof menuItemTones;
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <BaseMenu.Item
      className={cx(
        "flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-disabled:cursor-default data-disabled:opacity-50 data-highlighted:bg-subtle [&_svg]:size-4 [&_svg]:shrink-0",
        menuItemTones[tone],
      )}
      {...rest}
    >
      {icon}
      {children}
    </BaseMenu.Item>
  );
}

// Tabs

/** Underline tabs. Put a `TabPanel` per tab inside as children. */
export function Tabs(props: {
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: string }[];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <BaseTabs.Root
      value={props.value}
      onValueChange={(value) => props.onValueChange(String(value))}
      className={props.className}
    >
      <BaseTabs.List className="flex gap-1 border-b border-border">
        {props.items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className="-mb-px inline-flex h-9 cursor-pointer items-center border-b-2 border-transparent px-3 text-sm text-muted hover:text-foreground data-active:border-foreground data-active:text-foreground"
          >
            {item.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {props.children}
    </BaseTabs.Root>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <BaseTabs.Panel value={value} className="pt-6 outline-none">
      {children}
    </BaseTabs.Panel>
  );
}

// Page furniture

export function PageHeader(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Sits left of the title, such as an avatar. */
  leading?: ReactNode;
  /** Sits right of the title, such as a status badge. */
  badge?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {props.leading}
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
            {props.badge}
          </div>
          {props.description === undefined ? null : (
            <p className="text-sm text-muted">{props.description}</p>
          )}
        </div>
      </div>
      {props.actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{props.actions}</div>
      )}
    </header>
  );
}

/** Says what will appear here and what to do next; `action` is the button that does it. */
export function EmptyState(props: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
      {props.icon === undefined ? null : (
        <span aria-hidden className="text-muted [&_svg]:size-6">
          {props.icon}
        </span>
      )}
      <div className="grid gap-1">
        <p className="text-base font-semibold">{props.title}</p>
        {props.children === undefined ? null : (
          <p className="text-sm text-muted">{props.children}</p>
        )}
      </div>
      {props.action}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-md border border-border bg-subtle px-3 py-2 text-sm">
      {children}
    </p>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  return error === null || error === undefined ? null : (
    <p className="text-sm text-danger" role="alert">
      {describe(error)}
    </p>
  );
}

export function timeLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time}`;
}
