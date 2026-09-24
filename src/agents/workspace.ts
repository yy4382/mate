/** Initial recovery entry shared by local provisioning, Debian installation and clean-seat checks. */
export function initialMemory(name: string): string {
  return `# ${name}\n\nPrivate memory entry. Keep durable lessons and links to notes here.\n`;
}
