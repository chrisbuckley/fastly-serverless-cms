.PHONY: copy-shared build serve test clean

copy-shared:
	rm -rf shared
	cp -r ../shared ./shared

build: copy-shared
	fastly compute build

serve: copy-shared
	fastly compute serve

test: copy-shared
	go test -v ./...

clean:
	rm -rf shared bin pkg
