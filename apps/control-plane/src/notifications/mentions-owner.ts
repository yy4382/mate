export function mentionsOwner(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])@(?:owner|所有者)(?=$|[^\p{L}\p{N}_])/iu.test(text);
}
