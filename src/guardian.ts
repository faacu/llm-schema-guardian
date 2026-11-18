import { z, ZodError } from 'zod'

export interface GuardianOptions {
	maxRetries?: number
	llmCaller: (prompt: string) => Promise<string>
	onRetry?: (attempt: number, error: ZodError | SyntaxError) => void
}

/**
 * Forces an LLM to return JSON strictly matching a Zod schema.
 * On validation or JSON syntax errors, injects the failure details into a retry prompt (Auto-Healing).
 */
export async function generateWithHealing<T>(
	basePrompt: string,
	schema: z.ZodType<T>,
	options: GuardianOptions
): Promise<T> {
	const { maxRetries = 2, llmCaller, onRetry } = options

	if (!Number.isInteger(maxRetries) || maxRetries < 0) {
		throw new RangeError('[Guardian] maxRetries must be a non-negative integer')
	}

	let currentPrompt = basePrompt

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const rawResponse = await llmCaller(currentPrompt)

			const jsonMatch = rawResponse.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
			const jsonString = jsonMatch ? jsonMatch[0] : rawResponse

			const parsedJson: unknown = JSON.parse(jsonString)

			return schema.parse(parsedJson)
		} catch (error: unknown) {
			if (!(error instanceof ZodError) && !(error instanceof SyntaxError)) {
				throw error
			}

			if (attempt === maxRetries) {
				throw new Error(
					`[Guardian] Max retries (${maxRetries}) reached. LLM failed to match schema.`,
					{ cause: error }
				)
			}

			onRetry?.(attempt + 1, error)

			if (error instanceof ZodError) {
				const validationIssues = error.issues
					.map(issue => {
						const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
						return `${path}: ${issue.message}`
					})
					.join(', ')
				currentPrompt = `${basePrompt}\n\nIMPORTANT: Your previous response failed schema validation with these errors:\n${validationIssues}\n\nPlease fix the JSON payload and return ONLY valid JSON matching the exact schema.`
			} else {
				currentPrompt = `${basePrompt}\n\nIMPORTANT: Your previous response was not valid parsable JSON. Please return ONLY valid JSON without extra text or markdown formatting.`
			}
		}
	}

	throw new Error('Unexpected end of auto-healing loop')
}