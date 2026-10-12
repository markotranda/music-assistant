#!/usr/bin/env node
import { Command } from "commander";

const DEFAULT_API_URL = process.env.MA_API_URL ?? "http://localhost:8787";

const program = new Command();

program
  .name("ma")
  .description("Music Assistant CLI — follow trends, keep the library lean")
  .version("0.0.0");

program
  .command("health")
  .description("Check that the Music Assistant API is reachable")
  .option("-u, --url <url>", "API base URL", DEFAULT_API_URL)
  .action(async (opts: { url: string }) => {
    try {
      const res = await fetch(`${opts.url}/health`);
      const body = (await res.json()) as { status: string; version: string; time: string };
      console.log(`ok — version ${body.version} (${body.time})`);
    } catch (error) {
      console.error(`cannot reach ${opts.url}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  });

program.parseAsync();
