import { describe, it, expect, vi, beforeEach } from "vitest";
import type express from "express";
import { requireMcpAuth } from "../src/shared/auth.js";

function mockReqRes(authorization?: string) {
  const req = {
    headers: authorization !== undefined ? { authorization } : {},
  } as express.Request;

  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as express.Response;

  const next = vi.fn();

  return { req, res, next, status, json };
}

describe("requireMcpAuth", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("responds 503 when MCP_AUTH_SECRET is unset", () => {
    vi.stubEnv("MCP_AUTH_SECRET", "");
    const { req, res, next, status } = mockReqRes("Bearer anything");

    requireMcpAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when the Authorization header is missing", () => {
    vi.stubEnv("MCP_AUTH_SECRET", "correct-secret");
    const { req, res, next, status } = mockReqRes(undefined);

    requireMcpAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when the token doesn't match", () => {
    vi.stubEnv("MCP_AUTH_SECRET", "correct-secret");
    const { req, res, next, status } = mockReqRes("Bearer wrong-secret");

    requireMcpAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 for a malformed header (missing Bearer prefix)", () => {
    vi.stubEnv("MCP_AUTH_SECRET", "correct-secret");
    const { req, res, next, status } = mockReqRes("correct-secret");

    requireMcpAuth(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and writes no response when the token matches", () => {
    vi.stubEnv("MCP_AUTH_SECRET", "correct-secret");
    const { req, res, next, status } = mockReqRes("Bearer correct-secret");

    requireMcpAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});
