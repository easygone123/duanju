const bridge = window.__waooBerniniDirectorBridge;

if (!bridge?.api) {
    throw new Error("waoowaoo Bernini Director API bridge is unavailable");
}

export const api = bridge.api;
