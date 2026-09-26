#!/usr/bin/env node
// janitor command-line entry point.
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2));
