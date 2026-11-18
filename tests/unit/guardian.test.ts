import { afterEach, describe, expect, it, vi } from 'vitest'
import { z, ZodError } from 'zod'
import { generateWithHealing } from '../../src/guardian'

const userSchema = z.object({
	name: z.string().min(1),
	age: z.number().int().positive()
})

describe('generateWithHealing', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns validated data on the first attempt for valid JSON', async () => {
		const llmCaller = vi.fn(async () => '{"name": "Alice", "age": 30}')

		const result = await generateWithHealing('Return user', userSchema, { llmCaller })

		expect(result).toEqual({ name: 'Alice', age: 30 })
		expect(llmCaller).toHaveBeenCalledTimes(1)
		expect(llmCaller).toHaveBeenCalledWith('Return user')
	})

	it('extracts JSON wrapped in markdown fences and extra text', async () => {
		const llmCaller = vi.fn(
			async () => 'Here is the payload:\n```json\n{"name": "Bob", "age": 25}\n```\nDone.'
		)

		const result = await generateWithHealing('Return user', userSchema, { llmCaller })

		expect(result).toEqual({ name: 'Bob', age: 25 })
		expect(llmCaller).toHaveBeenCalledTimes(1)
	})

	it('supports top-level JSON arrays', async () => {
		const listSchema = z.array(z.string())
		const llmCaller = vi.fn(async () => '```json\n["alpha", "beta"]\n```')

		const result = await generateWithHealing('Return tags', listSchema, { llmCaller })

		expect(result).toEqual(['alpha', 'beta'])
	})

	it('auto-heals Zod validation errors by injecting issue details into the retry prompt', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const llmCaller = vi
			.fn<(prompt: string) => Promise<string>>()
			.mockResolvedValueOnce('{"name": "Alice", "age": "thirty"}')
			.mockResolvedValueOnce('{"name": "Alice", "age": 30}')

		const result = await generateWithHealing('Return user', userSchema, { llmCaller })

		expect(result).toEqual({ name: 'Alice', age: 30 })
		expect(llmCaller).toHaveBeenCalledTimes(2)
		expect(warnSpy).not.toHaveBeenCalled()

		const secondPrompt = llmCaller.mock.calls[1]?.[0] ?? ''
		expect(secondPrompt).toContain('failed schema validation')
		expect(secondPrompt).toContain('age:')
	})

	it('formats root-level Zod error path as (root) in the retry prompt', async () => {
		const llmCaller = vi
			.fn<(prompt: string) => Promise<string>>()
			.mockResolvedValueOnce('["not", "an", "object"]')
			.mockResolvedValueOnce('{"name": "Alice", "age": 30}')

		const result = await generateWithHealing('Return user', userSchema, { llmCaller })

		expect(result).toEqual({ name: 'Alice', age: 30 })
		expect(llmCaller).toHaveBeenCalledTimes(2)

		const secondPrompt = llmCaller.mock.calls[1]?.[0] ?? ''
		expect(secondPrompt).toContain('(root):')
	})

	it('invokes onRetry callback with attempt number and error instance without calling console.warn', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const onRetry = vi.fn()
		const llmCaller = vi
			.fn<(prompt: string) => Promise<string>>()
			.mockResolvedValueOnce('not-valid-json')
			.mockResolvedValueOnce('{"name": "Alice", "age": "thirty"}')
			.mockResolvedValueOnce('{"name": "Alice", "age": 30}')

		const result = await generateWithHealing('Return user', userSchema, {
			maxRetries: 2,
			llmCaller,
			onRetry
		})

		expect(result).toEqual({ name: 'Alice', age: 30 })
		expect(onRetry).toHaveBeenCalledTimes(2)
		expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(SyntaxError))
		expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(ZodError))
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('auto-heals JSON syntax errors by instructing the LLM to return valid JSON', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const llmCaller = vi
			.fn<(prompt: string) => Promise<string>>()
			.mockResolvedValueOnce('Not valid JSON at all')
			.mockResolvedValueOnce('{"name": "Carol", "age": 42}')

		const result = await generateWithHealing('Return user', userSchema, { llmCaller })

		expect(result).toEqual({ name: 'Carol', age: 42 })
		expect(llmCaller).toHaveBeenCalledTimes(2)
		expect(warnSpy).not.toHaveBeenCalled()

		const secondPrompt = llmCaller.mock.calls[1]?.[0] ?? ''
		expect(secondPrompt).toContain('not valid parsable JSON')
	})

	it('throws an Error with the original cause when maxRetries is exhausted', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const llmCaller = vi.fn(async () => '{"name": "Alice", "age": -5}')

		let caughtError: unknown
		try {
			await generateWithHealing('Return user', userSchema, {
				maxRetries: 2,
				llmCaller
			})
		} catch (error: unknown) {
			caughtError = error
		}

		expect(llmCaller).toHaveBeenCalledTimes(3)
		expect(caughtError).toBeInstanceOf(Error)
		expect((caughtError as Error).message).toContain('Max retries (2) reached')
		expect((caughtError as Error).cause).toBeInstanceOf(ZodError)
	})

	it('does not retry when maxRetries is 0', async () => {
		const llmCaller = vi.fn(async () => 'broken json')

		await expect(
			generateWithHealing('Return user', userSchema, {
				maxRetries: 0,
				llmCaller
			})
		).rejects.toThrow('Max retries (0) reached')

		expect(llmCaller).toHaveBeenCalledTimes(1)
	})

	it('rethrows non-healable errors immediately without retrying', async () => {
		const networkError = new TypeError('Network timeout')
		const llmCaller = vi.fn(async () => {
			throw networkError
		})

		await expect(
			generateWithHealing('Return user', userSchema, {
				maxRetries: 3,
				llmCaller
			})
		).rejects.toThrow(networkError)

		expect(llmCaller).toHaveBeenCalledTimes(1)
	})

	it('rethrows non-healable errors on the final attempt instead of masking them', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const apiError = new Error('503 Service Unavailable')
		const llmCaller = vi
			.fn<(prompt: string) => Promise<string>>()
			.mockResolvedValueOnce('invalid json')
			.mockRejectedValueOnce(apiError)

		await expect(
			generateWithHealing('Return user', userSchema, {
				maxRetries: 1,
				llmCaller
			})
		).rejects.toThrow(apiError)

		expect(llmCaller).toHaveBeenCalledTimes(2)
	})

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'throws RangeError for invalid maxRetries value: %s',
		async invalidRetries => {
			const llmCaller = vi.fn(async () => '{"name": "Alice", "age": 30}')

			await expect(
				generateWithHealing('Return user', userSchema, {
					maxRetries: invalidRetries,
					llmCaller
				})
			).rejects.toThrow(RangeError)

			expect(llmCaller).not.toHaveBeenCalled()
		}
	)
})
