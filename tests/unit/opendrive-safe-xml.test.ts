import { describe, expect, it } from "vitest";
import { parseOpenDrive, parseXml } from "../../packages/opendrive-network-compiler/src/index.js";

describe("secure XML parser", () => {
  it("rejects DTD and entity declarations before parsing", () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')).toThrow("forbidden");
  });
  it("does not degrade unsupported plan geometry to a line", () => {
    const source = '<?xml version="1.0"?><OpenDRIVE><header revMajor="1" revMinor="5"/><road id="1" name="x" length="1" junction="-1"><planView><geometry s="0" x="0" y="0" hdg="0" length="1"><poly3 a="0" b="0" c="0" d="0"/></geometry></planView><lanes><laneSection s="0"><center><lane id="0" type="none"/></center></laneSection></lanes></road></OpenDRIVE>';
    expect(() => parseOpenDrive(source)).toThrow("UNSUPPORTED_PLANVIEW_GEOMETRY");
  });
});
