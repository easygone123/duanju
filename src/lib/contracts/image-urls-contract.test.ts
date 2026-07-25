import { expect, test } from 'vitest'
import {
  ImageUrlsContractError,
  decodeImageUrlsFromDb,
  decodeImageUrlsStrict,
  encodeImageUrls,
} from './image-urls-contract'

test('encodeImageUrls returns JSON array string', () => {
  const encoded = encodeImageUrls(['a', 'b'])
  expect(encoded).toBe('["a","b"]')
})

test('decodeImageUrlsStrict parses valid JSON array', () => {
  const decoded = decodeImageUrlsStrict('["a","b"]')
  expect(decoded).toEqual(['a', 'b'])
})

test('decodeImageUrlsStrict throws on invalid JSON', () => {
  expect(() => decodeImageUrlsStrict('not-json')).toThrow(ImageUrlsContractError)
})

test('decodeImageUrlsStrict throws on non-array JSON', () => {
  expect(() => decodeImageUrlsStrict('{"a":1}')).toThrow(ImageUrlsContractError)
})

test('decodeImageUrlsStrict throws on non-string array entry', () => {
  expect(() => decodeImageUrlsStrict('["a",1]')).toThrow(ImageUrlsContractError)
})

test('decodeImageUrlsFromDb treats legacy null as an empty image array', () => {
  expect(decodeImageUrlsFromDb(null)).toEqual([])
  expect(decodeImageUrlsFromDb(undefined)).toEqual([])
})
