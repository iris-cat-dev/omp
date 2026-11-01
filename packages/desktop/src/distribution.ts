import path from "node:path";
import { readPackagedDesktopDistribution } from "./packaged-distribution.js";

const distribution = readPackagedDesktopDistribution(path.join(__dirname, ".."));

export const DESKTOP_DISTRIBUTION_IDENTITY = distribution.identity;
