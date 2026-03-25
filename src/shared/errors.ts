import type { Logger } from "./logger.js";

export class McpToolError extends Error {
  constructor(
    public userMessage: string,
    public actionableSteps: string,
    public override cause?: unknown,
  ) {
    super(userMessage);
    this.name = "McpToolError";
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new McpToolError(
      `Missing required environment variable: ${name}`,
      `Set ${name} in your .env file or Railway environment variables.`,
    );
  }
  return value;
}

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function toolSuccess(data: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

export function handleToolError(err: unknown, logger: Logger): McpToolResult {
  if (err instanceof McpToolError) {
    logger.error(err.userMessage, {
      cause: err.cause instanceof Error ? err.cause.message : String(err.cause ?? ""),
    });
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.userMessage}. ${err.actionableSteps}`,
        },
      ],
      isError: true,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  logger.error("Unexpected error", {
    error: message,
    stack: err instanceof Error ? err.stack : undefined,
  });

  return {
    content: [
      {
        type: "text",
        text: "Error: An unexpected error occurred. Check server logs for details and retry the operation.",
      },
    ],
    isError: true,
  };
}
