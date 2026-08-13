# Type Status + Unified Field System

## Important rule

Statuses and battlefield fields are **separate mechanics**.

- A **status** belongs to one Pokémon.
- A **field** belongs to the entire battle.
- Inflicting a status **never** activates that type's field.
- A field is created only by a move that explicitly declares a `field` effect, or by an ability that explicitly creates a field.
- There is no generic chance for every damaging move to inflict its type's status.

## Move data

A move can explicitly declare a status:

```json
{
  "kind": "status",
  "status": "Scorch",
  "chance": 0.1
}
```

Or a battlefield field:

```json
{
  "kind": "field",
  "field": "Inferno",
  "duration": 5
}
```

A move may declare both when its specific design calls for both, but neither is implied by the move's type.

## Abilities

Abilities such as Koraidon's Orichalcum Pulse and Miraidon's Hadron Engine can explicitly create their field on entry. Their field creation is independent from status conditions.

## Sunny Day

`Sunny Day` explicitly creates the `Inferno` field. It does not rely on a status condition to do so.
