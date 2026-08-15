import type { HtmlEscapedString } from 'hono/utils/html'

export async function renderToString(
  jsx: HtmlEscapedString | Promise<HtmlEscapedString>,
): Promise<string> {
  return await (jsx as unknown as { toString(): Promise<string> }).toString()
}