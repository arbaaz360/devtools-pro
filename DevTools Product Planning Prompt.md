I want to design and build a commercial desktop developer utility/workbench inspired by products such as DevUtils, but the goal is to make it perceivably better rather than simply clone it.

The product should eventually become a comprehensive "Swiss Army knife" for developers: one application for inspecting, transforming, formatting, validating, converting, comparing, generating, decoding, encoding, querying, and working with common developer data and file formats.

A few product objectives are non-negotiable:

1. **Blazing-fast performance**
   - The application should feel like a real high-performance native desktop application, closer to Notepad++ or Obsidian than a sluggish web application wrapped as desktop software.
   - Startup, navigation, tool switching, typing, opening files, and normal interactions should feel effectively instantaneous.
   - It must comfortably handle large inputs. A 50 MB JSON/XML/CSV/text file should be considered normal rather than an edge case.
   - Where practical, the design should allow substantially larger files in the future.
   - Expensive operations must never make the application itself feel frozen or unresponsive.

2. **Extreme modularity and decoupling**
   - Individual tools/features should be highly isolated from one another.
   - Adding a new tool should have minimal or ideally zero impact on existing tools.
   - I want to be able to continuously add dozens or eventually hundreds of capabilities without turning the application into a tightly coupled monolith.
   - Features should be independently testable, maintainable, replaceable, and removable.

3. **Very high extensibility**
   - Assume this product will grow significantly over time.
   - The initial architecture should make adding new tools inexpensive and predictable.
   - Common capabilities should be reusable without creating hidden dependencies between individual tools.
   - The design should not paint us into a corner as new categories of developer utilities are added.

4. **Excellent look and feel**
   - It should be visually polished, modern, minimal, professional, and enjoyable to use every day.
   - UX matters as much as functionality.
   - Common operations should take very few clicks or keystrokes.
   - Power users should be able to work extremely quickly.
   - The product should feel cohesive even though internally it is highly modular.

5. **Developer-first productivity**
   - Smart input/file detection.
   - Excellent keyboard-driven workflow.
   - Command palette / universal search.
   - Clipboard-friendly workflows.
   - Fast open/edit/transform/save workflows.
   - Useful defaults with advanced controls available when required.
   - Eventually support chaining/composing transformations where that creates genuine value.

6. **Commercial-product quality**
   - This is intended to become a paid product, not a programming exercise.
   - Reliability, polish, predictable behaviour, good error handling, useful feedback, maintainability, and performance are therefore important.
   - Avoid features that merely inflate the feature count without creating meaningful developer value.

I want you to approach this as a product architect and technical architect.

First, help me define the product properly.

Create a **comprehensive long-term feature catalogue** of developer tools this application could eventually support. Be exhaustive and organise them into logical categories rather than giving me a random flat list.

Consider areas such as:

- JSON
- YAML
- XML
- CSV / TSV
- TOML / INI / properties files
- Base64 and other encodings
- URL / URI / query strings
- JWT / OAuth / OIDC
- UUID / GUID
- hashes / checksums / HMAC
- encryption-related utilities
- certificates / PEM / X.509
- timestamps / dates / time zones
- regex
- text manipulation
- diff / compare
- SQL
- Markdown
- HTML / CSS
- JavaScript / TypeScript
- C# / Java / Python and other code-related transformations
- HTTP requests and responses
- cURL
- REST
- GraphQL
- OpenAPI / Swagger
- JSON Schema
- Protocol Buffers
- environment variables
- connection strings
- Docker
- Docker Compose
- Kubernetes
- Helm
- Terraform / infrastructure configuration
- cron expressions
- logs
- stack traces
- exception analysis
- Unicode / character inspection
- escape/unescape operations
- number/base conversions
- random-data generation
- QR codes
- data generation / mock data
- schema inference
- serialization/deserialization helpers
- API-development utilities
- security-related inspection utilities
- developer file inspection
- data extraction/querying
- formatting/minification
- validation
- conversion between formats
- offline developer productivity utilities

Do not restrict yourself to this list. Identify other useful categories and tools that belong in a serious developer workbench.

For every proposed tool, consider whether it provides enough real value to deserve being part of the product rather than existing just to increase the tool count.

Then recommend the **top 5 tools/capabilities we should build first**.

Choose those first five based on a combination of:

- frequency of developer use
- strength of the pain point
- ability to demonstrate the product's performance
- usefulness across many types of developers
- differentiation potential
- likelihood that someone would pay for the overall product
- ability to establish foundations that make later tools easier to add

Explain briefly why each belongs in the first five.

Do **not** assume a particular UI framework, programming language, plugin mechanism, architecture style, or technology stack yet.

I have deliberately described **what I want the product to achieve**, not how it should be implemented.

After understanding these objectives, propose the architecture, technology choices, performance strategy, modularity model, extensibility approach, UX approach, and phased implementation plan that you believe best satisfy them.

Challenge my assumptions where appropriate. The target is not "DevUtils with more tools." The target is a developer workbench that users perceive as **faster, more powerful, better designed, and easier to extend than existing alternatives**.