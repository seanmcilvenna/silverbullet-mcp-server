import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, loadMcpInstructions } from "../dist/mcp.js";

const instructionVariables = ["MCP_INSTRUCTIONS", "MCP_INSTRUCTIONS_FILE"];

async function withInstructionEnvironment(values, callback) {
  const original = Object.fromEntries(instructionVariables.map((name) => [name, process.env[name]]));

  try {
    for (const name of instructionVariables) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    return await callback();
  } finally {
    for (const name of instructionVariables) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
}

async function initializeAndGetInstructions() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer({});
  const client = new Client({ name: "instructions-test", version: "0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const instructions = client.getInstructions();
  await client.close();
  return instructions;
}

function startServer(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("initialize response has no instructions when no instruction setting is configured", { concurrency: false }, async () => {
  await withInstructionEnvironment({}, async () => {
    assert.equal(await initializeAndGetInstructions(), undefined);
  });
});

test("initialize response exposes MCP_INSTRUCTIONS", { concurrency: false }, async () => {
  await withInstructionEnvironment({ MCP_INSTRUCTIONS: "Test knowledge policy" }, async () => {
    assert.equal(await initializeAndGetInstructions(), "Test knowledge policy");
  });
});

test("initialize response preserves internal newlines in MCP_INSTRUCTIONS", { concurrency: false }, async () => {
  const instructions = "line one\nline two\nline three";
  await withInstructionEnvironment({ MCP_INSTRUCTIONS: instructions }, async () => {
    assert.equal(await initializeAndGetInstructions(), instructions);
  });
});

test("whitespace-only MCP_INSTRUCTIONS behaves as unset", { concurrency: false }, async () => {
  await withInstructionEnvironment({ MCP_INSTRUCTIONS: " \n\t " }, async () => {
    assert.equal(await initializeAndGetInstructions(), undefined);
  });
});

test("MCP_INSTRUCTIONS_FILE takes precedence over MCP_INSTRUCTIONS", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "silverbullet-mcp-instructions-"));
  const file = join(directory, "instructions.md");

  try {
    await writeFile(file, "file version\n", "utf8");
    await withInstructionEnvironment(
      { MCP_INSTRUCTIONS: "environment", MCP_INSTRUCTIONS_FILE: file },
      async () => {
        assert.equal(await initializeAndGetInstructions(), "file version");
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly configured unreadable MCP_INSTRUCTIONS_FILE fails startup clearly", { concurrency: false }, async () => {
  const missingFile = join(tmpdir(), "missing-mcp-instructions-file.md");
  const result = await startServer({
    SB_URL: "http://127.0.0.1:1",
    SB_TOKEN: "test-sb-token",
    MCP_TOKEN: "test-mcp-token",
    PUBLIC_URL: "http://127.0.0.1:18081",
    OAUTH_CLIENT_ID: "test-client-id",
    OAUTH_CLIENT_SECRET: "test-client-secret",
    OWNER_TOKEN: "test-owner-token",
    JWT_SIGNING_KEY: "test-jwt-signing-key",
    PORT: "18081",
    MCP_INSTRUCTIONS_FILE: missingFile,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unable to read MCP_INSTRUCTIONS_FILE.*missing-mcp-instructions-file\.md/);
});