require("dotenv").config()

module.exports = {
  schema: ["./lib/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
}
