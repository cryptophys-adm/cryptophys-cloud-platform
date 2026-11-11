import Organism from "./Organism";
import { call } from "../lib/api";

/**
 * Digital metabolism is unified into the Organism cockpit as baseline (#270, #272, #276).
 * Verified live endpoint: call("kernel.metabolism")
 */
export default function Metabolism() {
  // Renders the unified living organism cockpit
  return <Organism />;
}
