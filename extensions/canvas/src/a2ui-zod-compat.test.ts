import {
  ButtonApi,
  CardApi,
  Catalog,
  CommonSchemas,
  ComponentContext,
  GenericBinder,
  MessageProcessor,
  RowApi,
  extractRefFields,
} from "@a2ui/web_core/v0_9";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

describe("A2UI Zod 4 compatibility", () => {
  it("preserves public schema inference after the Zod major migration", () => {
    expectTypeOf<z.infer<typeof CommonSchemas.ComponentId>>().toEqualTypeOf<string>();
    expectTypeOf<z.infer<typeof CommonSchemas.ChildList>>().toEqualTypeOf<
      string[] | { componentId: string; path: string }
    >();
    expectTypeOf<z.infer<typeof CommonSchemas.Action>>().not.toBeAny();
    expectTypeOf<z.infer<typeof CommonSchemas.DynamicString>>().not.toBeAny();
  });

  it("preserves action context and dynamic bindings in a custom catalog", () => {
    const schema = z.object({
      title: CommonSchemas.DynamicString,
      action: CommonSchemas.Action.optional(),
      child: CommonSchemas.ComponentId.optional(),
    });
    const catalog = new Catalog("compat", [{ name: "Custom", schema }]);
    const processor = new MessageProcessor([catalog]);
    processor.processMessages([
      { version: "v0.9", createSurface: { surfaceId: "s", catalogId: catalog.id } },
      {
        version: "v0.9",
        updateDataModel: { surfaceId: "s", path: "/title", value: "Bound title" },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s",
          components: [
            {
              id: "root",
              component: "Custom",
              title: { path: "/title" },
              action: { event: { name: "save", context: { answer: 42 } } },
              child: "child",
            },
          ],
        },
      },
    ]);
    const surface = processor.model.getSurface("s")!;
    const binder = new GenericBinder(new ComponentContext(surface, "root"), schema);
    expect(binder.snapshot).toMatchObject({ title: "Bound title", action: expect.any(Function) });
    expect(extractRefFields(schema).get("child")).toEqual({ kind: "single" });
    expect(
      CommonSchemas.Action.parse({ event: { name: "save", context: { answer: 42 } } }),
    ).toEqual({ event: { name: "save", context: { answer: 42 } } });
  });

  it("exports inline catalog properties and child references with the native converter", () => {
    const processor = new MessageProcessor([new Catalog("basic", [ButtonApi, CardApi, RowApi])]);
    expect(processor.getClientCapabilities({ includeInlineCatalogs: true })).toMatchObject({
      "v0.9": {
        inlineCatalogs: [
          {
            components: {
              Card: {
                allOf: [
                  expect.anything(),
                  { properties: { child: { $ref: "common_types.json#/$defs/ComponentId" } } },
                ],
              },
              Row: {
                allOf: [
                  expect.anything(),
                  { properties: { children: { $ref: "common_types.json#/$defs/ChildList" } } },
                ],
              },
              Button: {
                allOf: [expect.anything(), { properties: { action: expect.any(Object) } }],
              },
            },
          },
        ],
      },
    });
  });

  it("loads JSON catalog object properties and unconstrained function arguments", () => {
    const catalog = Catalog.fromSchema({
      catalogId: "record-compat",
      components: {
        Custom: { type: "object", properties: { data: { type: "object" } }, required: ["data"] },
      },
      functions: [{ name: "custom", returnType: "boolean" }],
    });
    expect(catalog.components.get("Custom")?.schema.parse({ data: { answer: 42 } })).toEqual({
      data: { answer: 42 },
    });
    expect(catalog.functions.get("custom")?.schema.parse({ answer: 42 })).toEqual({ answer: 42 });
  });

  it("rejects oversized collections before element parsing and leaves component state unchanged", () => {
    let parsed = 0;
    const schema = z.object({
      values: z
        .array(
          z.string().refine(() => {
            parsed++;
            return true;
          }),
        )
        .max(2),
    });
    const processor = new MessageProcessor([new Catalog("bounded", [{ name: "Bounded", schema }])]);
    processor.processMessages([
      { version: "v0.9", createSurface: { surfaceId: "s", catalogId: "bounded" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s",
          components: [{ id: "root", component: "Bounded", values: ["ok"] }],
        },
      },
    ]);
    parsed = 0;
    expect(() =>
      processor.processMessages([
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "s",
            components: [
              { id: "root", values: ["changed"] },
              { id: "bad", component: "Bounded", values: Array(1000).fill("bad") },
            ],
          },
        },
      ]),
    ).toThrow("Validation failed");
    expect(parsed).toBe(1);
    const surface = processor.model.getSurface("s")!;
    expect(surface.componentsModel.get("root")!.properties).toEqual({ values: ["ok"] });
    expect(surface.componentsModel.get("bad")).toBeUndefined();
  });
});
