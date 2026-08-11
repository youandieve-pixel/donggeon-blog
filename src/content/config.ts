import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().optional().default(''),
    pubDate: z.date(),
    tags: z.array(z.string()).default([]),
    image: z.string().optional()
  })
});

export const collections = { blog };
