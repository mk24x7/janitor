# fastq [![CI](https://github.com/mk/fastq/actions/workflows/ci.yml/badge.svg)](https://github.com/mk/fastq/actions) [![npm](https://img.shields.io/npm/v/fastq.svg)](https://www.npmjs.com/package/fastq)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![codecov](https://codecov.io/gh/mk/fastq/badge.svg)](https://codecov.io/gh/mk/fastq)

[Docs](https://fastq.dev/docs) | [Demo](https://fastq.dev/demo) | [Changelog](CHANGELOG.md)

Fast, **in-memory** work queue for Node.js with `async` workers and back pressure. See the [guide](https://fastq.dev/guide) for details.

## Usage

```js
const q = fastq(worker, 1)
```
