/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { jest } from "@jest/globals"
import { createKeychain } from "./keychain.js"

function execErr(code, stderr) {
    const err = new Error(`Command failed: security`)
    err.code = code
    err.stderr = stderr
    return err
}

describe("createKeychain", () => {
    test("runs security with service and -w, trims the value", async () => {
        const exec = jest.fn(async () => ({ stdout: "secret-token\n" }))
        const kc = createKeychain({ exec })
        await expect(kc.get("command-center-asana")).resolves.toBe(
            "secret-token"
        )
        expect(exec).toHaveBeenCalledWith("security", [
            "find-generic-password",
            "-s",
            "command-center-asana",
            "-w",
        ])
    })

    test("passes the account when given and accepts string output", async () => {
        const exec = jest.fn(async () => "  value  ")
        const kc = createKeychain({ exec })
        await expect(kc.get("svc", "leo")).resolves.toBe("value")
        expect(exec.mock.calls[0][1]).toEqual([
            "find-generic-password",
            "-s",
            "svc",
            "-a",
            "leo",
            "-w",
        ])
    })

    test("returns null for empty output", async () => {
        const kc = createKeychain({ exec: async () => ({ stdout: "\n" }) })
        await expect(kc.get("svc")).resolves.toBeNull()
        const kc2 = createKeychain({ exec: async () => ({}) })
        await expect(kc2.get("svc")).resolves.toBeNull()
    })

    test("returns null when the item is not found (exit 44)", async () => {
        const log = { debug: jest.fn() }
        const kc = createKeychain({
            exec: async () => {
                throw execErr(44, "")
            },
            log,
        })
        await expect(kc.get("svc")).resolves.toBeNull()
        expect(log.debug).toHaveBeenCalled()
    })

    test("returns null when stderr says not found", async () => {
        const kc = createKeychain({
            exec: async () => {
                throw execErr(
                    1,
                    "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."
                )
            },
        })
        await expect(kc.get("svc")).resolves.toBeNull()
    })

    test("other failures throw keychain_error without leaking output", async () => {
        const kc = createKeychain({
            exec: async () => {
                const e = execErr(51, "user interaction is not allowed")
                e.stdout = "s3cr3t"
                throw e
            },
        })
        const err = await kc.get("svc").catch((e) => e)
        expect(err.code).toBe("keychain_error")
        expect(err.message).toContain("exit 51")
        expect(err.message).not.toContain("s3cr3t")
    })

    test("unknown error shape", async () => {
        const kc = createKeychain({
            exec: async () => {
                throw undefined
            },
        })
        const err = await kc.get("svc").catch((e) => e)
        expect(err.message).toContain("exit unknown")
    })

    test("requires a service", async () => {
        const kc = createKeychain({ exec: jest.fn() })
        await expect(kc.get("")).rejects.toMatchObject({
            code: "keychain_error",
        })
    })
})
