### **Installation Guide for NaruhoDocs VSCode extension**

#### **Step 1: Prerequisites**
- **Install Visual Studio Code** (required for VSIX installation):  
  [Download VS Code](https://code.visualstudio.com/) for Windows, macOS, or Linux.

---

#### **Step 2: Download the VSIX File**
- Download `naruhodocs-0.0.2.vsix` file from our [GitHub release page](https://github.com/shinyeongbeh/NaruhoDocs/releases). 

---

#### **Step 3: Install the Extension**
1. **Open Visual Studio Code**.
2. **Open the Extensions View**:
   - Click the **Extensions icon** (square with a globe) in the Activity Bar.
   - Or press `Ctrl+Shift+X` (Windows/Linux) / `Cmd+Shift+X` (macOS).
3. **Install from VSIX**:
   - Click the **"..."** menu (three dots) in the top-right corner of the Extensions view.
   - Select **"Install from VSIX..."**.
   - Navigate to the location of your `.vsix` file and select it.
4. **Wait for installation**:
   - VS Code will install the extension and reload if necessary.

---

#### **Step 4: Verify Installation**
- Return to the **Extensions view**.
- Look for your app’s name in the list. If it’s not there, check the **"Installed"** tab.

---

#### **Step 5: Enable the Extension (if needed)**
- If your app requires specific permissions or settings:
  - Go to **File > Preferences > Extensions**.
  - Click the **"Enable"** button for your app.
  - Configure any required settings in the extension’s context menu.

---

#### **Troubleshooting Tips**
- **Error: "Cannot install extension"**:
  - Ensure the `.vsix` file is not corrupted.
- **Security Block**:
  - If installation is blocked, go to **File > Preferences > Extensions** and click **"Allow"** next to your app.
- **Missing Dependencies**:
  - Some extensions require additional tools (e.g., Node.js, Python). Refer to your app’s documentation for requirements.

---

#### **Post-Installation**
- Launch your app via VS Code (if it’s a toolchain or plugin).
- Check for configuration options in the extension’s settings. You might want to configure your LLM options there. 