import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import * as yaml from "yaml"
import type { MarketplaceItem, MarketplaceItemType, InstallMarketplaceItemOptions, McpParameter } from "@roo-code/types"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { ensureSettingsDirectoryExists } from "../../utils/globalContext"
import type { CustomModesManager } from "../../core/config/CustomModesManager"

export interface InstallOptions extends InstallMarketplaceItemOptions {
	target: "project" | "global"
	selectedIndex?: number // Which installation method to use (for array content)
}

export class SimpleInstaller {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly customModesManager?: CustomModesManager,
	) {}

	async installItem(item: MarketplaceItem, options: InstallOptions): Promise<{ filePath: string; line?: number }> {
		const { target } = options

		switch (item.type) {
			case "mode":
				return await this.installMode(item, target)
			case "mcp":
				return await this.installMcp(item, target, options)
			default:
				throw new Error(`Unsupported item type: ${(item as any).type}`)
		}
	}

	private async installMode(
		item: MarketplaceItem,
		target: "project" | "global",
	): Promise<{ filePath: string; line?: number }> {
		if (!item.content) {
			throw new Error("Mode item missing content")
		}

		// Modes should always have string content, not array
		if (Array.isArray(item.content)) {
			throw new Error("Mode content should not be an array")
		}

		// If CustomModesManager is available, use importModeWithRules
		if (this.customModesManager) {
			// Transform marketplace content to import format (wrap in customModes array)
			const importData = {
				customModes: [yaml.parse(item.content)],
			}
			const importYaml = yaml.stringify(importData)

			// Call customModesManager.importModeWithRules
			const result = await this.customModesManager.importModeWithRules(importYaml, target)

			if (!result.success) {
				throw new Error(result.error || "Failed to import mode")
			}

			// Return the file path and line number for VS Code to open
			const filePath = await this.getModeFilePath(target)

			// Try to find the line number where the mode was added
			let line: number | undefined
			try {
				const fileContent = await fs.readFile(filePath, "utf-8")
				const lines = fileContent.split("\n")
				const modeData = yaml.parse(item.content)

				// Find the line containing the slug of the added mode
				if (modeData?.slug) {
					const slugLineIndex = lines.findIndex(
						(l) => l.includes(`slug: ${modeData.slug}`) || l.includes(`slug: "${modeData.slug}"`),
					)
					if (slugLineIndex >= 0) {
						line = slugLineIndex + 1 // Convert to 1-based line number
					}
				}
			} catch (error) {
				// If we can't find the line number, that's okay
			}

			return { filePath, line }
		}

		// Fallback to original implementation if CustomModesManager is not available
		const filePath = await this.getModeFilePath(target)
		const modeData = yaml.parse(item.content)

		// Read existing file or create new structure
		let existingData: any = { customModes: [] }
		try {
			const existing = await fs.readFile(filePath, "utf-8")
			const parsed = yaml.parse(existing)
			// Ensure we have a valid object with customModes array
			existingData = parsed && typeof parsed === "object" ? parsed : { customModes: [] }
		} catch (error: any) {
			if (error.code === "ENOENT") {
				// File doesn't exist, use default structure - this is fine
				existingData = { customModes: [] }
			} else if (error.name === "YAMLParseError" || error.message?.includes("YAML")) {
				// YAML parsing error - don't overwrite the file!
				const fileName = target === "project" ? ".kilocodemodes" : "custom-modes.yaml"
				throw new Error(
					`Cannot install mode: The ${fileName} file contains invalid YAML. ` +
						`Please fix the syntax errors in the file before installing new modes.`,
				)
			} else {
				// Other unexpected errors - re-throw
				throw error
			}
		}

		// Ensure customModes array exists
		if (!existingData.customModes) {
			existingData.customModes = []
		}

		// The content is now a single mode object directly
		if (!modeData.slug) {
			throw new Error("Invalid mode content: mode missing slug")
		}

		// Remove existing mode with same slug if it exists
		existingData.customModes = existingData.customModes.filter((mode: any) => mode.slug !== modeData.slug)

		// Add the new mode
		existingData.customModes.push(modeData)
		const addedModeIndex = existingData.customModes.length - 1

		// Write back to file
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		const yamlContent = yaml.stringify(existingData, { lineWidth: 0 })
		await fs.writeFile(filePath, yamlContent, "utf-8")

		// Calculate approximate line number where the new mode was added
		let line: number | undefined
		if (addedModeIndex >= 0) {
			const lines = yamlContent.split("\n")
			// Find the line containing the slug of the added mode
			const addedMode = existingData.customModes[addedModeIndex]
			if (addedMode?.slug) {
				const slugLineIndex = lines.findIndex(
					(l) => l.includes(`slug: ${addedMode.slug}`) || l.includes(`slug: "${addedMode.slug}"`),
				)
				if (slugLineIndex >= 0) {
					line = slugLineIndex + 1 // Convert to 1-based line number
				}
			}
		}

		return { filePath, line }
	}

	private async installMcp(
		item: MarketplaceItem,
		target: "project" | "global",
		options?: InstallOptions,
	): Promise<{ filePath: string; line?: number }> {
		if (!item.content) {
			throw new Error("MCP item missing content")
		}

		// Get the content to use
		let contentToUse: string
		if (Array.isArray(item.content)) {
			// Array of McpInstallationMethod objects
			const index = options?.selectedIndex ?? 0
			const method = item.content[index] || item.content[0]
			contentToUse = method.content
		} else {
			contentToUse = item.content
		}

		// Get method-specific parameters if using array content
		let methodParameters: McpParameter[] = []
		if (Array.isArray(item.content)) {
			const index = options?.selectedIndex ?? 0
			const method = item.content[index] || item.content[0]
			methodParameters = method.parameters || []
		}

		// Merge parameters (method-specific override global)
		const itemParameters = item.type === "mcp" ? item.parameters || [] : []
		const allParameters = [...itemParameters, ...methodParameters]
		const uniqueParameters = Array.from(new Map(allParameters.map((p) => [p.key, p])).values())

		// Replace parameters if provided
		if (options?.parameters && uniqueParameters.length > 0) {
			for (const param of uniqueParameters) {
				const value = options.parameters[param.key]
				if (value !== undefined) {
					contentToUse = contentToUse.replace(new RegExp(`{{${param.key}}}`, "g"), String(value))
				}
			}
		}

		// Handle _selectedIndex from parameters if provided
		if (options?.parameters?._selectedIndex !== undefined && Array.isArray(item.content)) {
			const index = options.parameters._selectedIndex
			if (index >= 0 && index < item.content.length) {
				// Array of McpInstallationMethod objects
				const method = item.content[index]
				contentToUse = method.content
				methodParameters = method.parameters || []

				// Re-merge parameters with the newly selected method
				const itemParametersForNewMethod = item.type === "mcp" ? item.parameters || [] : []
				const allParametersForNewMethod = [...itemParametersForNewMethod, ...methodParameters]
				const uniqueParametersForNewMethod = Array.from(
					new Map(allParametersForNewMethod.map((p) => [p.key, p])).values(),
				)

				// Re-apply parameter replacements to the newly selected content
				for (const param of uniqueParametersForNewMethod) {
					const value = options.parameters[param.key]
					if (value !== undefined) {
						contentToUse = contentToUse.replace(new RegExp(`{{${param.key}}}`, "g"), String(value))
					}
				}
			}
		}

		const filePath = await this.getMcpFilePath(target)
		const mcpData = JSON.parse(contentToUse)

		// Read existing file or create new structure
		let existingData: any = { mcpServers: {} }
		try {
			const existing = await fs.readFile(filePath, "utf-8")
			existingData = JSON.parse(existing) || { mcpServers: {} }
		} catch (error: any) {
			if (error.code === "ENOENT") {
				// File doesn't exist, use default structure
				existingData = { mcpServers: {} }
			} else if (error instanceof SyntaxError) {
				// JSON parsing error - don't overwrite the file!
				const fileName = target === "project" ? ".kilocode/mcp.json" : "mcp-settings.json"
				throw new Error(
					`Cannot install MCP server: The ${fileName} file contains invalid JSON. ` +
						`Please fix the syntax errors in the file before installing new servers.`,
				)
			} else {
				// Other unexpected errors - re-throw
				throw error
			}
		}

		// Ensure mcpServers object exists
		if (!existingData.mcpServers) {
			existingData.mcpServers = {}
		}

		// Use the item id as the server name
		const serverName = item.id

		// Add or update the single server
		existingData.mcpServers[serverName] = mcpData

		// Write back to file
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		const jsonContent = JSON.stringify(existingData, null, 2)
		await fs.writeFile(filePath, jsonContent, "utf-8")

		// Calculate approximate line number where the new server was added
		let line: number | undefined
		if (serverName) {
			const lines = jsonContent.split("\n")
			// Find the line containing the server name
			const serverLineIndex = lines.findIndex((l) => l.includes(`"${serverName}"`))
			if (serverLineIndex >= 0) {
				line = serverLineIndex + 1 // Convert to 1-based line number
			}
		}

		return { filePath, line }
	}

	async removeItem(item: MarketplaceItem, options: InstallOptions): Promise<void> {
		const { target } = options

		switch (item.type) {
			case "mode":
				await this.removeMode(item, target)
				break
			case "mcp":
				await this.removeMcp(item, target)
				break
			default:
				throw new Error(`Unsupported item type: ${(item as any).type}`)
		}
	}

	private async removeMode(item: MarketplaceItem, target: "project" | "global"): Promise<void> {
		if (!this.customModesManager) {
			throw new Error("CustomModesManager is not available")
		}

		// Parse the item content to get the slug
		let content: string
		if (Array.isArray(item.content)) {
			// Array of McpInstallationMethod objects - use first method
			content = item.content[0].content
		} else {
			content = item.content || ""
		}

		let modeSlug: string
		try {
			const modeData = yaml.parse(content)
			modeSlug = modeData.slug
		} catch (error) {
			throw new Error("Invalid mode content: unable to parse YAML")
		}

		if (!modeSlug) {
			throw new Error("Mode missing slug identifier")
		}

		// Get the current modes to determine the source
		const modes = await this.customModesManager.getCustomModes()
		const mode = modes.find((m) => m.slug === modeSlug)

		// Use CustomModesManager to delete the mode configuration
		// This also handles rules folder deletion
		await this.customModesManager.deleteCustomMode(modeSlug, true)
	}

	private async removeMcp(item: MarketplaceItem, target: "project" | "global"): Promise<void> {
		const filePath = await this.getMcpFilePath(target)

		try {
			const existing = await fs.readFile(filePath, "utf-8")
			const existingData = JSON.parse(existing)

			if (existingData?.mcpServers) {
				// Parse the item content to get server names
				let content: string
				if (Array.isArray(item.content)) {
					// Array of McpInstallationMethod objects - use first method
					content = item.content[0].content
				} else {
					content = item.content
				}

				const serverName = item.id
				delete existingData.mcpServers[serverName]

				// Always write back the file, even if empty
				await fs.writeFile(filePath, JSON.stringify(existingData, null, 2), "utf-8")
			}
		} catch (error) {
			// File doesn't exist or other error, nothing to remove
		}
	}

	private async getModeFilePath(target: "project" | "global"): Promise<string> {
		if (target === "project") {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
			if (!workspaceFolder) {
				throw new Error("No workspace folder found")
			}
			return path.join(workspaceFolder.uri.fsPath, ".kilocodemodes")
		} else {
			const globalSettingsPath = await ensureSettingsDirectoryExists(this.context)
			return path.join(globalSettingsPath, GlobalFileNames.customModes)
		}
	}

	private async getMcpFilePath(target: "project" | "global"): Promise<string> {
		if (target === "project") {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
			if (!workspaceFolder) {
				throw new Error("No workspace folder found")
			}
			return path.join(workspaceFolder.uri.fsPath, ".kilocode", "mcp.json")
		} else {
			const globalSettingsPath = await ensureSettingsDirectoryExists(this.context)
			return path.join(globalSettingsPath, GlobalFileNames.mcpSettings)
		}
	}
}
