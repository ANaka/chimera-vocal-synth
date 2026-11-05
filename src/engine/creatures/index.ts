/** Creature registry. */
import type { CreatureDef } from "./types.ts";
import { SONGBIRD } from "./songbird.ts";
import { SEAL } from "./seal.ts";
import { ALLIGATOR } from "./alligator.ts";
import { ELEPHANT } from "./elephant.ts";

export const CREATURES: CreatureDef[] = [SONGBIRD, SEAL, ALLIGATOR, ELEPHANT];
export const creatureById = (id: string) => CREATURES.find((c) => c.id === id);
