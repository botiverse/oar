import { expect, test } from "vitest";
import { cursorSkillsContextFactory } from "../../sea-trial/vendor/support/copied-sdk-bundle.js";

const anchor = "return skillsService";
const factory = "const ctx=(0,$module.make$$)(),nested=options.loadNestedRules??!0";
const other = "const other=(0,otherModule.factory)(),flag=otherOptions.loadNestedRules";

function bundle(body: string): string {
  return `${other};async loadLocalExtensibility(options){${body};${anchor}};${other}`;
}

test("reads the context factory from the skill loader containing the observation anchor", () => {
  expect(cursorSkillsContextFactory(bundle(factory), anchor)).toBe("(0,$module.make$$)()");
});

test("an unrelated call cannot substitute for a missing loader context factory", () => {
  expect(() => cursorSkillsContextFactory(bundle("const ctx=(0,otherModule.factory)()"), anchor)).toThrow(/found 0/u);
});

test("two matching factory calls in the observed loader are ambiguous", () => {
  expect(() => cursorSkillsContextFactory(bundle(`${factory};${other}`), anchor)).toThrow(/found 2/u);
});
