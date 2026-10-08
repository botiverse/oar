import { expect, test, vi } from "vitest";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

for (const kind of ["prompt", "steer", "queue"] as const) {
  test.each([{ images: undefined }, { images: [] }])(`${kind}: empty input is recorded and refused before consulting the adapter, images=%j`, async ({ images }) => {
    const kernel = createSessionKernel("s");
    const decide = vi.fn(() => ({ kind: "accepted" as const }));
    const body = { kind, input: "", ...(images === undefined ? {} : { images }) };
    const result = await kernel.control(body, decide);
    expect(result.request.body).toEqual(body);
    expect(result.response.body).toMatchInlineSnapshot(`
      {
        "code": "unsupported",
        "kind": "rejected",
        "reason": "empty input: give text or images",
      }
    `);
    expect(decide).not.toHaveBeenCalled();
    expect(kernel.records()).toEqual([result.request, result.response]);
  });

  test.each([{ input: "", images: [{ path: "/image.png" }] }, { input: " \n\t" }])(`${kind}: valid input reaches the adapter unchanged: %j`, async (input) => {
    const kernel = createSessionKernel("s");
    const decide = vi.fn(() => ({ kind: "accepted" as const }));
    const body = { kind, ...input };
    const result = await kernel.control(body, decide);
    expect(result.response.body.kind).toBe("accepted");
    expect(decide).toHaveBeenLastCalledWith(result.request);
    expect(result.request.body).toEqual(body);
  });
}
