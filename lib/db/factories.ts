import { faker } from "@faker-js/faker";
import type { NewMember } from "./schema.ts";

export function fakeMember(overrides: Partial<NewMember> = {}): NewMember {
  return {
    email: faker.internet.email().toLowerCase(),
    name: faker.person.fullName(),
    role: "researcher",
    ...overrides,
  };
}
