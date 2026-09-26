// License texts for `janitor license`. MIT and ISC are bundled; any other
// SPDX identifier is fetched from the GitHub licenses API.

import { UsageError } from './errors.js';

const MIT = `MIT License

Copyright (c) [year] [fullname]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const ISC = `ISC License

Copyright (c) [year] [fullname]

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

const BUNDLED = { mit: { spdx: 'MIT', body: MIT }, isc: { spdx: 'ISC', body: ISC } };

function fill(body, { year, holder }) {
  return body
    .replace(/\[year\]|\[yyyy\]|<year>/g, String(year))
    .replace(/\[fullname\]|\[name of copyright owner\]|<name of author>|<copyright holders>/g, holder);
}

/**
 * @returns {Promise<{ spdx: string, text: string }>}
 */
export async function licenseText(client, spdx, { year, holder }) {
  if (!holder || !String(holder).trim()) throw new UsageError('a copyright holder is required (use --holder)');
  const key = String(spdx ?? 'MIT').toLowerCase();
  const bundled = BUNDLED[key];
  if (bundled) return { spdx: bundled.spdx, text: fill(bundled.body, { year, holder }) };
  const data = await client.getOptional(`/licenses/${encodeURIComponent(key)}`);
  if (!data?.body) throw new UsageError(`unknown license "${spdx}"; see https://api.github.com/licenses`);
  return { spdx: data.spdx_id ?? spdx, text: fill(data.body, { year, holder }) };
}
