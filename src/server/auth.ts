import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const COOKIE = "fi_admin";
const LIFETIME_MS = 12 * 60 * 60 * 1000;

function secret(): string {
  const value = process.env.ADMIN_COOKIE_SECRET;
  if (!value) throw new Error("ADMIN_COOKIE_SECRET is not set");
  return value;
}

function sign(expires: string): string {
  return createHmac("sha256", secret()).update(expires).digest("hex");
}

function same(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function passcodeMatches(passcode: string): boolean {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) throw new Error("ADMIN_PASSCODE is not set");
  return same(passcode, expected);
}

export function setAdminCookie(res: Response): void {
  const expires = String(Date.now() + LIFETIME_MS);
  res.cookie(COOKIE, `${expires}.${sign(expires)}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" && !process.env.ALLOW_INSECURE_COOKIE,
    maxAge: LIFETIME_MS,
    path: "/",
  });
}

export function clearAdminCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value ?? "");
  }
  return undefined;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const [expires, signature] = (readCookie(req) ?? "").split(".");
  if (expires && signature && same(signature, sign(expires)) && Number(expires) > Date.now()) {
    next();
    return;
  }
  res.status(401).json({ error: "Please log in" });
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// No 0/O or 1/I/L, so a printed code can't be misread.
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newTeamCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join("");
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}
