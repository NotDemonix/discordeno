import { encode } from './base64.js';

/** Converts a url to base 64. Useful for example, uploading/creating server emojis. */
export async function urlToBase64(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);

  const imageStr = encode(await response.arrayBuffer());
  const contentType = response.headers.get('content-type')?.split(';')[0];
  const pathname = new URL(url).pathname;
  const type = pathname.includes('.') ? pathname.substring(pathname.lastIndexOf('.') + 1) : 'png';

  return `data:${contentType || `image/${type}`};base64,${imageStr}`;
}
