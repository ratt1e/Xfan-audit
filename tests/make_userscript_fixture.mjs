import fs from "fs";

function user(id, handle, name, verified, followers) {
  return {
    __typename: "User",
    rest_id: id,
    is_blue_verified: !!verified,
    core: {name: name, screen_name: handle},
    relationship_counts: {followers: followers || 0, following: 1},
    verification: {verified: !!verified}
  };
}

function timelineUser(person) {
  return {
    entryId: "user-" + person.rest_id,
    sortIndex: "20",
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: {__typename: "TimelineUser", user_results: {result: person}}
    }
  };
}

function tweetResult(partial) {
  const raw = {
    __typename: "Tweet",
    rest_id: partial.id,
    core: {user_results: {result: user(partial.uid, partial.handle, partial.name, partial.verified, 3)}},
    legacy: {
      id_str: partial.id,
      full_text: partial.text,
      created_at: partial.created,
      in_reply_to_status_id_str: partial.replyTo || null,
      in_reply_to_screen_name: partial.replyToHandle || null,
      conversation_id_str: partial.conv || partial.replyTo || partial.id
    }
  };
  if (partial.retweet) {
    raw.legacy.retweeted_status_result = {result: {__typename: "Tweet", rest_id: "1001999", legacy: {full_text: "转的", id_str: "1001999"}}};
  }
  if (partial.wrap) return {__typename: "TweetWithVisibilityResults", tweet: raw};
  return raw;
}

function tweetEntry(partial) {
  return {
    entryId: "tweet-" + partial.id,
    sortIndex: "10",
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: {__typename: "TimelineTweet", tweet_results: {result: tweetResult(partial)}}
    }
  };
}

function itemTweet(entryId, partial) {
  return {
    entryId: entryId,
    item: {itemContent: {__typename: "TimelineTweet", tweet_results: {result: tweetResult(partial)}}}
  };
}

function profile() {
  return user("1000001", "demo_owner", "演示主人", false, 20);
}

function userTimeline(person, entries) {
  const result = Object.assign({}, person, {
    timeline: {timeline: {instructions: [{
      type: "TimelineAddEntries",
      entries: entries.concat([{entryId: "cursor-bottom-1", content: {entryType: "TimelineTimelineCursor"}}])
    }]}}
  });
  return {data: {user: {result: result}}};
}

const owner = profile();
const following = userTimeline(owner, [
  timelineUser(user("1000002", "user_01", "演示甲", true, 120)),
  timelineUser(user("1000003", "user_02", "演示乙", false, 4)),
  timelineUser(user("1000004", "user_03", "演示丙", false, 8))
]);
const followers = userTimeline(owner, [
  timelineUser(user("1000002", "user_01", "演示甲", true, 120)),
  timelineUser(user("1000004", "user_03", "演示丙", false, 8))
]);
const blue = userTimeline(owner, [
  timelineUser(user("1000002", "user_01", "演示甲", true, 120))
]);
const replies = userTimeline(owner, [
  {
    entryId: "profile-conversation-1001001",
    sortIndex: "9",
    content: {
      entryType: "TimelineTimelineModule",
      items: [
        itemTweet("profile-conversation-1001001-tweet-1001001", {
          id: "1001001", uid: "1000005", handle: "user_04", name: "演示丁",
          text: "这条是认真回复的内容甲", created: "Mon Oct 19 16:00:00 +0000 2026",
          replyTo: "1003001", replyToHandle: "demo_owner", conv: "1003001"
        }),
        itemTweet("profile-conversation-1001001-tweet-1001002", {
          id: "1001002", uid: "1000005", handle: "user_04", name: "演示丁",
          text: "这条是认真回复的内容乙", created: "Tue Oct 20 16:00:00 +0000 2026",
          replyTo: "1003001", replyToHandle: "demo_owner", conv: "1003001"
        })
      ]
    }
  },
  tweetEntry({
    id: "1001003", uid: "1000005", handle: "user_04", name: "演示丁",
    text: "这条是认真回复的内容丙", created: "Wed Oct 21 16:00:00 +0000 2026",
    replyTo: "1003001", replyToHandle: "demo_owner", conv: "1003001", wrap: true
  }),
  tweetEntry({
    id: "1001004", uid: "1000006", handle: "user_07", name: "演示庚",
    text: "RT 一下", created: "Wed Oct 21 17:00:00 +0000 2026", retweet: true
  })
]);
const longText = "早安" + "！".repeat(40) + "后面还有很多实质内容要说清楚才行呀";
const originals = userTimeline(owner, [
  tweetEntry({
    id: "1005001", uid: "1000013", handle: "user_05", name: "演示戊", text: longText,
    created: "Wed Oct 21 12:00:00 +0000 2026", replyTo: "1005000", replyToHandle: "demo_owner", conv: "1005000"
  }),
  tweetEntry({
    id: "1005002", uid: "1000013", handle: "user_05", name: "演示戊", text: longText,
    created: "Tue Oct 20 12:00:00 +0000 2026", replyTo: "1005000", replyToHandle: "demo_owner", conv: "1005000"
  }),
  tweetEntry({
    id: "1005003", uid: "1000013", handle: "user_05", name: "演示戊", text: longText,
    created: "Mon Oct 19 12:00:00 +0000 2026", replyTo: "1005000", replyToHandle: "demo_owner", conv: "1005000"
  })
]);
const search = {data: {search_by_raw_query: {search_timeline: {timeline: {instructions: [{type: "TimelineAddEntries", entries: [
  tweetEntry({
    id: "1001003", uid: "1000005", handle: "user_04", name: "演示丁",
    text: "这条是认真回复的内容丙", created: "Wed Oct 21 16:00:00 +0000 2026",
    replyTo: "1003001", replyToHandle: "demo_owner", conv: "1003001"
  }),
  tweetEntry({
    id: "1001008", uid: "1000009", handle: "user_09", name: "演示壬",
    text: "这是回给别人的", created: "Wed Oct 21 18:00:00 +0000 2026",
    replyTo: "1003010", replyToHandle: "user_02", conv: "1003010"
  })
]}]}}}}};
const detail = {data: {threaded_conversation_with_injections_v2: {instructions: [
  {type: "TimelineAddEntries", entries: [{
    entryId: "conversationthread-1004001",
    content: {entryType: "TimelineTimelineModule", items: [
      itemTweet("conversationthread-1004001-tweet-1002001", {
        id: "1002001", uid: "1000001", handle: "demo_owner", name: "演示主人",
        text: "我也回了一句具体的话", created: "Wed Oct 21 19:00:00 +0000 2026",
        replyTo: "1004001", replyToHandle: "user_08", conv: "1004001"
      }),
      {entryId: "conversationthread-1004001-cursor-showmore-1", item: {itemContent: {__typename: "TimelineTimelineCursor"}}}
    ]}
  }]},
  {type: "TimelineAddToModule", moduleItems: [
    itemTweet("conversationthread-1004001-tweet-1002002", {
      id: "1002002", uid: "1000011", handle: "user_09", name: "演示壬",
      text: "楼里插一句但不是回你", created: "Wed Oct 21 19:10:00 +0000 2026",
      replyTo: "1004002", replyToHandle: "user_07", conv: "1004009"
    })
  ]}
]}}};
const otherFollowing = userTimeline(user("1000003", "user_02", "演示乙", false, 4), [
  timelineUser(user("1000012", "user_11", "演示癸", false, 1))
]);
const fixture = {
  owner: "demo_owner",
  events: [
    {op: "Following", body: following},
    {op: "Followers", body: followers},
    {op: "BlueVerifiedFollowers", body: blue},
    {op: "UserRepliesTimeline", body: replies},
    {op: "UserOriginalsTimeline", body: originals},
    {op: "SearchTimeline", query: "to:demo_owner", body: search},
    {op: "TweetDetail", body: detail},
    {op: "Following", body: otherFollowing, owner: "user_02"}
  ]
};
const text = JSON.stringify(fixture, null, 2) + "\n";
if (/(?<!\d)\d{15,20}(?!\d)/.test(text)) throw new Error("fixture has a long id");
fs.writeFileSync(new URL("./fixtures/userscript_sample.json", import.meta.url), text);
console.log("wrote", text.length);
