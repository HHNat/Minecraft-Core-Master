import path from "path";
import os from "os";

let customFolderName: string | null = null;

const MinecraftFolder = {
    getDefault(): string {
        switch (os.type()) {
            case "Darwin":
                return path.join(
                    os.homedir(),
                    "Library",
                    "Application Support",
                    "minecraft"
                );

            case "Windows_NT":
                return path.join(
                    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
                    ".minecraft"
                );

            default:
                return path.join(os.homedir(), ".minecraft");
        }
    },

    getFolder(): string {
        if (!customFolderName) return this.getDefault();
        const defaultPath = this.getDefault();
        return path.join(path.dirname(defaultPath), customFolderName);
    },

    setFolder(folderName: string) {
        customFolderName = folderName;
    },
};

export default MinecraftFolder;
