const express = require("express");
const router = express.Router();
const SpotifyWebApi = require("spotify-web-api-node");
const dotenv = require("dotenv");

dotenv.config();

const scopes = [
  "user-read-private",
  "user-read-email",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-follow-modify",
];

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
});

router.get("/", async (req, res) => {
  res.render("index", { title: "Express" });
});

router.get("/login", (req, res) => {
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, {
    showDialog: true,
  });
  res.redirect(authorizeURL);
});

router.get("/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { body } = await spotifyApi.authorizationCodeGrant(code);
    const { access_token, refresh_token } = body;
    spotifyApi.setAccessToken(access_token);
    spotifyApi.setRefreshToken(refresh_token);
    res.send("<script>window.close();</script>");
  } catch (err) {
    res.redirect("/#/error/invalid-token");
  }
});

router.get("/create-playlist/:artistId", async (req, res) => {
  try {
    const artistId = req.params.artistId;

    if (!spotifyApi.getAccessToken()) {
      res.redirect("/login");
      return;
    }

    const allAlbums = await fetchAllAlbums(artistId);
    const artistName = allAlbums[0].artists[0].name;

    const sortedAlbums = allAlbums.sort(
      (a, b) => new Date(a.release_date) - new Date(b.release_date)
    );

    const albumData = sortedAlbums.map((album) => ({
      id: album.id,
      album_group: album.album_group,
    }));

    const tracks = await getAllTrackData(albumData, artistName);
    const uniqueTracks = removeDuplicateTracks(tracks);
    const tracksWithoutAlternateVersions =
      removeAlternateVersions(uniqueTracks);

    const allSongsPlaylistTitle = `All ${artistName} songs`;
    const allSongsPlaylist = await spotifyApi.createPlaylist(
      allSongsPlaylistTitle,
      {
        description:
          "All of the songs, excluding alternate versions (preferring latest album release)",
      }
    );

    const allSongsPlaylistId = allSongsPlaylist.body.id;

    const chunkSize = 100;
    const trackUris = tracksWithoutAlternateVersions.map((track) => track.uri);

    for (let i = 0; i < trackUris.length; i += chunkSize) {
      const chunk = trackUris.slice(i, i + chunkSize);

      try {
        await spotifyApi.addTracksToPlaylist(allSongsPlaylistId, chunk);
      } catch (err) {
        console.error(`Error adding tracks to playlist: ${err.message}`);
        res.status(500).send("Error adding tracks to playlist");
        return;
      }
    }

    try {
      await spotifyApi.followArtists([artistId]);
    } catch (err) {
      console.error(`Error following artist: ${err.message}`);
    }

    res.status(200).send("Playlist created successfully.");
    return;
  } catch (err) {
    console.error("Error:", err);
    res.status(400).send(err);
  }
});

async function fetchAllAlbums(artistId) {
  const allAlbums = [];
  let offset = 0;
  const limit = 49;

  const fetchAlbums = async (includeGroups) => {
    while (true) {
      const { body: albums } = await spotifyApi.getArtistAlbums(artistId, {
        include_groups: includeGroups,
        limit,
        offset,
      });

      if (albums.items.length === 0) {
        break;
      }

      albums.items.forEach((album) => {
        allAlbums.push(album);
      });

      offset += limit;

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  await fetchAlbums("album");
  offset = 0;
  await fetchAlbums("single");
  offset = 0;
  await fetchAlbums("compilation");
  offset = 0;
  await fetchAlbums("appears_on");

  return allAlbums;
}

async function getAllTrackData(albumData, artistName) {
  const batchSize = 20;
  const trackBatchSize = 50;
  const delayBetweenRequests = 1000;

  const fetchAlbumDetails = async (albumIds) => {
    const albumsResponse = await spotifyApi.getAlbums(albumIds);
    return albumsResponse.body.albums;
  };

  const fetchTrackDetails = async (trackIds) => {
    const tracksResponse = await spotifyApi.getTracks(trackIds);
    return tracksResponse.body.tracks;
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let tracks = [];
  let trackIds = [];

  for (let i = 0; i < albumData.length; i += batchSize) {
    const currentBatch = albumData.slice(i, i + batchSize);
    const albumIds = currentBatch.map((album) => album.id);

    const albums = await fetchAlbumDetails(albumIds);
    const albumTracks = albums.flatMap((album) => {
      const albumDataEntry = albumData.find((entry) => entry.id === album.id);
      return album.tracks.items
        .filter((track) =>
          track.artists.some((artist) => artist.name === artistName)
        )
        .map((track) => ({
          id: track.id,
          title: track.name,
          uri: track.uri,
          album_type: album.album_type,
          external: albumDataEntry.album_group === "appears_on",
          artists: track.artists.map((artist) => artist.name),
          duration_ms: track.duration_ms,
        }));
    });

    tracks = [...tracks, ...albumTracks];
    trackIds = [...trackIds, ...albumTracks.map((track) => track.id)];

    await delay(delayBetweenRequests);
  }

  const trackData = [];
  for (let i = 0; i < trackIds.length; i += trackBatchSize) {
    const chunk = trackIds.slice(i, i + trackBatchSize);
    const trackDetails = await fetchTrackDetails(chunk);
    trackData.push(...trackDetails);
    await delay(delayBetweenRequests);
  }

  tracks.forEach((track) => {
    const additionalData = trackData.find((data) => data.id === track.id);
    if (additionalData) {
      track.isrc = additionalData.external_ids.isrc;
      track.popularity = additionalData.popularity;
    }
  });

  return tracks;
}

const removeDuplicateTracks = (tracks) => {
  const uniqueTracks = new Map();

  tracks.forEach((track) => {
    const key = track.isrc;

    if (!uniqueTracks.has(key)) {
      uniqueTracks.set(key, track);
    } else {
      const previousTrack = uniqueTracks.get(key);

      if (track.external && previousTrack.external) {
        if (
          (track.album_type === "single" &&
            previousTrack.album_type !== "album") ||
          track.album_type === "album"
        ) {
          uniqueTracks.delete(key);
          uniqueTracks.set(key, track);
        }
      } else if (!track.external) {
        if (track.album_type === "single") {
          if (previousTrack.external) {
            if (
              previousTrack.album_type === "single" ||
              previousTrack.album_type === "album" ||
              previousTrack.album_type === "compilation"
            ) {
              uniqueTracks.delete(key);
              uniqueTracks.set(key, track);
            }
          } else if (
            previousTrack.album_type === "single" ||
            previousTrack.album_type === "compilation"
          ) {
            uniqueTracks.delete(key);
            uniqueTracks.set(key, track);
          }
        }

        if (track.album_type === "album") {
          uniqueTracks.delete(key);
          uniqueTracks.set(key, track);
        }

        if (track.album_type === "compilation") {
          if (previousTrack.album_type == "compilation") {
            uniqueTracks.delete(key);
            uniqueTracks.set(key, track);
          }
        }
      }
    }
  });

  return Array.from(uniqueTracks.values());
};

const removeAlternateVersions = (tracks) => {
  const uniqueTracks = new Map();

  tracks.forEach((track) => {
    if (track.title.includes("-") || track.title.includes("(")) {
      const title = track.title.toLowerCase();

      const keywords = [
        "version",
        "live",
        "remix",
        "edit",
        "acoustic",
        "stripped",
        "session",
        "sessions",
        "demo",
        "acapella",
        "a cappella",
        "memo",
        "track by track",
        "mix",
        "recorded at",
        "instrumental",
        "orchestral",
        "spotify singles",
        "commentary",
        "extended",
        "sped up",
        "slowed",
        "voicenote",
        "club",
        "dub",
        "radio",
        "fix",
      ];

      const exceptions = ["taylor"];

      let separatorIndex;
      if (title.includes("-") && title.includes("(")) {
        separatorIndex = Math.min(title.indexOf("-"), title.indexOf("("));
      } else if (title.includes("-")) {
        separatorIndex = title.indexOf("-");
      } else {
        separatorIndex = title.indexOf("(");
      }

      const titleBeforeSeparator = title.substring(0, separatorIndex).trim();
      const titleAfterSeparator = title.substring(separatorIndex + 1).trim();

      const hasKeyword = keywords.some((keyword) =>
        titleAfterSeparator.includes(keyword)
      );
      const hasException = exceptions.some((exception) =>
        titleAfterSeparator.includes(exception)
      );

      if (hasKeyword && !hasException) {
        const matchingTrack = tracks.find(
          (track) => track.title.toLowerCase() === titleBeforeSeparator
        );

        if (!matchingTrack) {
          uniqueTracks.set(track.isrc, track);
        } else {
          console.log(`Removed alternate version: ${track.title}`);
        }
      } else {
        uniqueTracks.set(track.isrc, track);
      }
    } else {
      uniqueTracks.set(track.isrc, track);
    }
  });

  return Array.from(uniqueTracks.values());
};

module.exports = router;
