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
  return withMcpClient({}, async (client) => client.getInstructions());
}

async function withMcpClient(sb, callback) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(sb);
  const client = new Client({ name: "instructions-test", version: "0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
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

function startRunningServer(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onOutput = (chunk) => {
      output += chunk;
      if (output.includes("silverbullet-mcp listening")) {
        cleanup();
        resolve(child);
      }
    };
    const cleanup = () => {
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onOutput);
      child.off("error", reject);
      child.off("exit", onExit);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited before listening (code ${code}): ${output}`));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", reject);
    child.on("exit", onExit);
  });
}

async function getKnowledgePolicy() {
  return withMcpClient(
    new Proxy(
      {},
      {
        get() {
          throw new Error("get_knowledge_policy must not access SilverBullet");
        },
      },
    ),
    async (client) => {
      const result = await client.callTool({ name: "get_knowledge_policy", arguments: {} });
      return result.content[0].text;
    },
  );
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

test("get_knowledge_policy is discoverable and returns the inline policy without using SilverBullet", { concurrency: false }, async () => {
  const policy = "Use this server for persistent personal knowledge.";
  await withInstructionEnvironment({ MCP_INSTRUCTIONS: policy }, async () => {
    await withMcpClient({}, async (client) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((candidate) => candidate.name === "get_knowledge_policy");
      assert.ok(tool);
      assert.equal(tool.inputSchema.type, "object");
      assert.deepEqual(tool.inputSchema.properties ?? {}, {});
      assert.match(tool.description, /authoritative|active knowledge-management policy/i);
    });
    assert.equal(await getKnowledgePolicy(), policy);
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
  const policy = "# Personal policy\n\n- Preserve [[Projects]] context.\n- Keep `tags` intact.\n";

  try {
    await writeFile(file, policy, "utf8");
    await withInstructionEnvironment(
      { MCP_INSTRUCTIONS: "environment", MCP_INSTRUCTIONS_FILE: file },
      async () => {
        assert.equal(await initializeAndGetInstructions(), policy.trim());
        assert.equal(await getKnowledgePolicy(), policy.trim());
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("get_knowledge_policy returns the documented message when no policy is configured", { concurrency: false }, async () => {
  await withInstructionEnvironment({}, async () => {
    assert.equal(
      await getKnowledgePolicy(),
      "No deployment-specific knowledge policy is configured for this MCP server.",
    );
  });
});

test("get_knowledge_policy exactly matches the initialization instructions", { concurrency: false }, async () => {
  const policy = "# Knowledge policy\n\nKeep [[Goals]] connected to `projects`.";
  await withInstructionEnvironment({ MCP_INSTRUCTIONS: policy }, async () => {
    await withMcpClient({}, async (client) => {
      const result = await client.callTool({ name: "get_knowledge_policy", arguments: {} });
      assert.equal(result.content[0].text, client.getInstructions());
    });
  });
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

test("unauthenticated clients cannot invoke MCP tools", { concurrency: false }, async () => {
  const port = "18082";
  const child = await startRunningServer({
    SB_URL: "http://127.0.0.1:1",
    SB_TOKEN: "test-sb-token",
    MCP_TOKEN: "test-mcp-token",
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    OAUTH_CLIENT_ID: "test-client-id",
    OAUTH_CLIENT_SECRET: "test-client-secret",
    OWNER_TOKEN: "test-owner-token",
    JWT_SIGNING_KEY: "test-jwt-signing-key",
    PORT: port,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_knowledge_policy", arguments: {} },
      }),
    });
    assert.equal(response.status, 401);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});