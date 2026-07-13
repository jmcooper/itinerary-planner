# AI Integration
I'd like to to intregrate an AI chat bot into this app to help with travel planning. Right now, I need to copy/paste output, in a very specific format, from a ChatGPT conversation to create an itinerary. I'd like to instead just have an integrated chat bot that I can use to create new itineraries, edit itineraries, etc.

## Itinerary Creation
When clicking on the "Create Trip" button on the home page, I'm currently presented with a "When is this trip?" dialog with date pickers. Then, after choosing dates, an itinerary is created and I'm taken to the /trips/[trip-id] page which shows the dates for the itinerary on the left side, and when clicking on each date, places to paste in an Itinerary CSV and Itinerary Details markdown.

Now, when clicking on the "Create Trip" button, I'd like to be presented with a single itinerary description textarea where I can define my itinerary. For example:

```
Create an itinerary for a trip to Yellowstone National Park for the dates 7/1/2026 through 7/4/2026. I plan to enter the park from West Yellowstone on the morning of 7/1 and leave yellowstone in the direction of Rexburg, Idaho on the evening of 7/4/2026. Define an efficient itinerary for each day that takes me to all the major sites in Yellowstone. Consider that my wife and I are in our mid-50's and are able to do long walks, we want to avoid strenuous hikes.
```

The textarea hint text for that trip description should have some hint text as to what to include such date ranges, etc. Once that itinerary description is submitted a persistent chat session should be created with a chat agent passing that itinerary description as the starting prompt. The agent should be instructed to return both a conversational response, structured JSON output for itinerary data, and a brief description of the itinerary. I imagine the structured response would look something like that shown in the section below with the header `### Structured Agent Response`.

The user should then be taken to the /trips/[trip-id] page which should now show a ghosted placeholder for the itineary days and details while the agent thinks. Then when the agent returns a structured response, the recommended itinerary should be saved and displayed in the current (or at least very similar) format currently used for the /trips page. But now an AI conversation chat interface should also be displayed to the right of the itinerary details (for mobile we'll have to have thos show below or maybe in a tabbed interface for switching betwen itinerary view and agent chat). The UI for the agent chat is described below in the section `## Agent Chat UI`. When landing on the trips page for a newly created itinerary, show the original prompt and agent response in the agent chat history.

### Strucutred Agent Response

```ts
{
  "answer": string
  "recommendedItinerary": ItineraryDay[]
  "summary": string
}
```

And `ItineraryDay` is defined as:
```ts
{ 
  date: Date //(a single day)
  title: string,
  mapLink: string, //should contain a link to google maps with waypoints for each of this day's ItineraryItems
  itineraryDetails: ItineraryItem[]
}
```

I'm not completely sold on the name `ItineraryItem`, it basically represents the plan for a specific timeblock (i.e. 8:15am - 8:45am). But I can't think of a better name right now. Whatever the name, a `ItineraryItem` is defined as:
```ts
{
  timeStart: Temporal.PlainTime,
  timeEnd: Temporal.EndTime,
  title: string,
  description: string //should support markdown
  images: string[] //should support storing image data uris
}
```

I'd like the data on disk to be stored in a similar (maybe identical) shape. Note that this will require a data-migration of existing data. Create a script to migrate this data and assume I'll run this once before deployment rather than making the app support old data formats.

## Agent Chat UI
The agent chat UI should consist of a large/tall non-editable chat history showing the alternating chat history with the user's questions/prompts aligned right in a chat bubble and the agent's response aligned left (not in a bubble for ease of reading). Conversational responses should just be shown as text, but with support for markdown (or other ways of adding things like bolded text, etc), but when displaying a recommended itinerary in the convesation text we may want to use sub-components to give the recommended itinerary a decent, but compact look when displayed in the agent chat. 

## Editing Itineraries
Once created (whether by AI or from legacy/stored data), an itinerary should be editable manually as it is now. But it should also be able to be edited via AI, for example if a user said something like, "Let's have day 2 end at 3pm so we can go back and rest" which would potentially cause the agent to modify that day and subsequent days.
