const bridge = window.__waooBerniniDirectorBridge;

if (!bridge?.app) {
    throw new Error("waoowaoo Bernini Director app bridge is unavailable");
}

export const app = bridge.app;
